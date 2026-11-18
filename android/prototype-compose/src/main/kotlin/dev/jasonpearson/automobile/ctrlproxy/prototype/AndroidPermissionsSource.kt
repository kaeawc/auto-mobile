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
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*

internal interface AndroidPermissionsGateway {
  val sdk: Int
  val foreground: Boolean
  val granted: Boolean
  val notificationsEnabled: Boolean
  val rationale: Boolean
  val resumes: Flow<Unit>

  /** Null when another session owns the Activity's prompt. */
  fun request(deliver: (Boolean) -> Unit, cancel: () -> Unit): (() -> Unit)?
}

/** Session-local denial history; a launch alone is not evidence of a denial. */
internal interface PrototypePermissionRequestStore {
  var asked: Boolean
}

class AndroidPermissionsSource
internal constructor(
  private val gateway: AndroidPermissionsGateway,
  private val store: PrototypePermissionRequestStore,
  private val dispatcher: CoroutineDispatcher,
) : PrototypePermissionsSource {
  constructor(
    activity: ComponentActivity,
  ) : this(
    FrameworkPermissionsGateway(activity),
    SessionPermissionRequestStore(),
    Dispatchers.Main.immediate,
  )

  private var closed = false
  private var finish: (() -> Unit)? = null
  override val changes: Flow<PrototypePermissionState> =
    gateway.resumes.filter { !closed && finish == null }.map { status() }.flowOn(dispatcher)

  override fun status(): PrototypePermissionState =
    if (closed || !gateway.foreground) PrototypePermissionState.UNAVAILABLE else authorization()

  private fun authorization(): PrototypePermissionState {
    if (gateway.sdk >= 33 && gateway.granted) store.asked = false
    return when {
      gateway.sdk < 33 ->
        if (gateway.notificationsEnabled) PrototypePermissionState.GRANTED
        else PrototypePermissionState.BLOCKED
      gateway.granted ->
        if (gateway.notificationsEnabled) PrototypePermissionState.GRANTED
        else PrototypePermissionState.BLOCKED
      !store.asked -> PrototypePermissionState.NOT_DETERMINED
      gateway.rationale -> PrototypePermissionState.DENIED
      else -> PrototypePermissionState.BLOCKED
    }
  }

  override fun session(): PrototypePermissionsSource =
    AndroidPermissionsSource(gateway, SessionPermissionRequestStore(), dispatcher)

  override fun request(): Flow<PrototypePermissionOutcome> = flow {
    val current = status()
    if (finish != null) {
      emit(PrototypePermissionOutcome.Busy)
      return@flow
    }
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
          store.asked = !granted
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

  override fun close() {
    closed = true
    store.asked = false
    finish?.invoke()
  }
}

private class SessionPermissionRequestStore : PrototypePermissionRequestStore {
  override var asked = false
}

internal class FrameworkPermissionsGateway(
  private val activity: ComponentActivity,
  private val activityResultRegistry: ActivityResultRegistry = activity.activityResultRegistry,
) : AndroidPermissionsGateway {
  private var requesting = false
  override val sdk
    get() = Build.VERSION.SDK_INT

  override val foreground
    get() =
      !activity.isFinishing &&
        !activity.isDestroyed &&
        activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

  override val granted
    get() = activity.checkSelfPermission(POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  override val notificationsEnabled
    get() = activity.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

  override val rationale
    get() = activity.shouldShowRequestPermissionRationale(POST_NOTIFICATIONS)

  override val resumes: Flow<Unit> = callbackFlow {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_RESUME) trySend(Unit)
    }
    activity.lifecycle.addObserver(observer)
    awaitClose { activity.lifecycle.removeObserver(observer) }
  }

  override fun request(deliver: (Boolean) -> Unit, cancel: () -> Unit): (() -> Unit)? {
    if (requesting) return null
    var active = true
    lateinit var launcher: ActivityResultLauncher<String>
    lateinit var observer: LifecycleEventObserver
    val unregister = {
      if (active) {
        active = false
        requesting = false
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
        "prototype.notifications.${nextRequest.incrementAndGet()}",
        ActivityResultContracts.RequestPermission(),
      ) { granted ->
        if (active && !activity.isDestroyed) deliver(granted)
      }
    requesting = true
    activity.lifecycle.addObserver(observer)
    try {
      launcher.launch(POST_NOTIFICATIONS)
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      unregister()
      throw error
    }
    return unregister
  }

  companion object {
    private val nextRequest = AtomicLong()
  }
}

// Manifest.permission.POST_NOTIFICATIONS, which only API 33 declares; used only on API 33+.
private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
