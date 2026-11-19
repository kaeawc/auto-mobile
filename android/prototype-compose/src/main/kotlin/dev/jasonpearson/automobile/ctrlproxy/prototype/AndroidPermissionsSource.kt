package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*

internal interface AndroidPermissionsGateway {
  val permission: PrototypeRuntimePermission
    get() = PrototypeRuntimePermission.NOTIFICATIONS

  /** Whether the host manifest requests [permission]; an undeclared one can never be granted. */
  val declared: Boolean
    get() = true

  /** A camera id or an audio input exists; notifications have no hardware. */
  val hardware: Boolean
    get() = true

  /**
   * A permission dialog of this Activity delivered its result and the Activity has not resumed
   * since. A follow-up request waits for that resume instead of reading `unavailable`.
   */
  val settling: Boolean
    get() = false

  /** Another source or session of this Activity has its permission dialog open. */
  val prompting: Boolean
    get() = false

  val sdk: Int
  val foreground: Boolean
  val granted: Boolean
  val notificationsEnabled: Boolean
  val rationale: Boolean
  val resumes: Flow<Unit>

  /** Null when another session owns the Activity's prompt. */
  fun request(deliver: (Boolean) -> Unit, cancel: () -> Unit): (() -> Unit)?
}

/** Session-local history of the system reporting that a permission rationale should be shown. */
internal interface PrototypePermissionRequestStore {
  var rationaleSeen: Boolean
}

class AndroidPermissionsSource
internal constructor(
  private val gateway: AndroidPermissionsGateway,
  private val store: PrototypePermissionRequestStore,
  private val dispatcher: CoroutineDispatcher,
) : PrototypePermissionsSource {
  constructor(
    activity: ComponentActivity,
    permission: PrototypeRuntimePermission = PrototypeRuntimePermission.NOTIFICATIONS,
  ) : this(activity, permission, PrototypePromptSlot())

  internal constructor(
    activity: ComponentActivity,
    permission: PrototypeRuntimePermission,
    slot: PrototypePromptSlot,
  ) : this(
    FrameworkPermissionsGateway(activity, permission = permission, slot = slot),
    SessionPermissionRequestStore(),
    Dispatchers.Main.immediate,
  )

  private var closed = false
  private val closing = MutableStateFlow(false)
  private var finish: (() -> Unit)? = null
  override val changes: Flow<PrototypePermissionState> =
    gateway.resumes.filter { !closed && finish == null }.map { status() }.flowOn(dispatcher)

  override fun status(): PrototypePermissionState =
    if (closed || !gateway.foreground) PrototypePermissionState.UNAVAILABLE else authorization()

  private fun authorization(): PrototypePermissionState {
    if (!gateway.declared || !gateway.hardware) return PrototypePermissionState.UNAVAILABLE
    val notifications = gateway.permission == PrototypeRuntimePermission.NOTIFICATIONS
    // Notifications became a runtime permission in API 33; camera and microphone always are.
    if (notifications && gateway.sdk < 33) return notificationSetting()
    if (gateway.granted) store.rationaleSeen = false
    else if (gateway.rationale) store.rationaleSeen = true
    return when {
      gateway.granted ->
        if (notifications) notificationSetting() else PrototypePermissionState.GRANTED
      !store.rationaleSeen -> PrototypePermissionState.NOT_DETERMINED
      gateway.rationale -> PrototypePermissionState.DENIED
      else -> PrototypePermissionState.BLOCKED
    }
  }

  private fun notificationSetting() =
    if (gateway.notificationsEnabled) PrototypePermissionState.GRANTED
    else PrototypePermissionState.BLOCKED

  override fun session(): PrototypePermissionsSource =
    AndroidPermissionsSource(gateway, SessionPermissionRequestStore(), dispatcher)

  override fun request(): Flow<PrototypePermissionOutcome> = flow {
    if (!awaitSettled()) {
      emit(PrototypePermissionOutcome.Cancelled)
      return@flow
    }
    // While any dialog is open the Activity is paused, so check ownership before status.
    if (finish != null || gateway.prompting) {
      emit(PrototypePermissionOutcome.Busy)
      return@flow
    }
    val current = status()
    if (
      current !in setOf(PrototypePermissionState.NOT_DETERMINED, PrototypePermissionState.DENIED)
    ) {
      emit(PrototypePermissionOutcome.Status(current))
      return@flow
    }
    val result = CompletableDeferred<Boolean?>()
    var cancelled = false
    val end = {
      cancelled = true
      result.complete(null)
      Unit
    }
    finish = end
    try {
      val unregister =
        gateway.request(
          { granted ->
            if (!closed && finish === end) result.complete(granted)
          },
          end,
        )
      if (unregister == null) {
        emit(PrototypePermissionOutcome.Busy)
        return@flow
      }
      try {
        val granted = result.await()
        if (closed || cancelled || granted == null) emit(PrototypePermissionOutcome.Cancelled)
        else {
          // Reaching here proves launch succeeded and a result was delivered. Results may precede
          // ON_RESUME, so read authorization without the foreground gate.
          emit(PrototypePermissionOutcome.Status(authorization()))
        }
      } finally {
        unregister()
      }
    } finally {
      if (finish === end) finish = null
    }
  }
    .flowOn(dispatcher)

  /**
   * A previous prompt's result can precede ON_RESUME; wait for the Activity to come back before
   * prompting again. False when the source closed while waiting.
   */
  private suspend fun awaitSettled(): Boolean {
    val idle = !closed && finish == null
    if (!idle || gateway.foreground || !gateway.settling) return true
    merge(gateway.resumes, closing.filter { it }.map {}).first()
    return !closed
  }

  override fun close() {
    closed = true
    closing.value = true
    store.rationaleSeen = false
    finish?.invoke()
  }
}

private class SessionPermissionRequestStore : PrototypePermissionRequestStore {
  override var rationaleSeen = false
}

internal class FrameworkPermissionsGateway(
  private val activity: ComponentActivity,
  private val activityResultRegistry: ActivityResultRegistry = activity.activityResultRegistry,
  override val permission: PrototypeRuntimePermission = PrototypeRuntimePermission.NOTIFICATIONS,
  private val slot: PrototypePromptSlot = PrototypePromptSlot(),
) : AndroidPermissionsGateway {
  private val manifestName = permission.manifest

  override val declared by lazy { declaresPermission(activity, manifestName) }

  override val hardware
    get() = captureHardwarePresent(activity, permission)

  override val settling
    get() = slot.settling

  override val prompting
    get() = slot.requesting

  override val sdk
    get() = Build.VERSION.SDK_INT

  override val foreground
    get() =
      !activity.isFinishing &&
        !activity.isDestroyed &&
        activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

  override val granted
    get() = activity.checkSelfPermission(manifestName) == PackageManager.PERMISSION_GRANTED

  override val notificationsEnabled
    get() = activity.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

  override val rationale
    get() = activity.shouldShowRequestPermissionRationale(manifestName)

  override val resumes: Flow<Unit> = callbackFlow {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_RESUME) trySend(Unit)
    }
    activity.lifecycle.addObserver(observer)
    awaitClose { activity.lifecycle.removeObserver(observer) }
  }

  override fun request(deliver: (Boolean) -> Unit, cancel: () -> Unit): (() -> Unit)? {
    if (slot.requesting) return null
    var active = true
    lateinit var launcher: ActivityResultLauncher<String>
    lateinit var observer: LifecycleEventObserver
    val unregister = {
      if (active) {
        active = false
        slot.requesting = false
        launcher.unregister()
        activity.lifecycle.removeObserver(observer)
      }
    }
    observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_DESTROY) {
        unregister()
        cancel()
      }
    }
    launcher =
      activityResultRegistry.register(
        "prototype.${permission.wire}.${nextRequest.incrementAndGet()}",
        ActivityResultContracts.RequestPermission(),
      ) { granted ->
        if (active && !activity.isDestroyed) {
          settleUntilResume()
          deliver(granted)
        }
      }
    slot.requesting = true
    activity.lifecycle.addObserver(observer)
    try {
      launcher.launch(manifestName)
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      unregister()
      throw error
    }
    return unregister
  }

  /** Marks the slot settling until the Activity's next resume (or destruction) clears it. */
  private fun settleUntilResume() {
    slot.settling = true
    activity.lifecycle.addObserver(
      object : LifecycleEventObserver {
        override fun onStateChanged(source: LifecycleOwner, event: Lifecycle.Event) {
          if (event != Lifecycle.Event.ON_RESUME && event != Lifecycle.Event.ON_DESTROY) return
          slot.settling = false
          source.lifecycle.removeObserver(this)
        }
      },
    )
  }

  companion object {
    private val nextRequest = AtomicLong()
  }
}
