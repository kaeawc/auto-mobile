package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import java.util.concurrent.atomic.AtomicLong
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

  fun request(deliver: () -> Unit): () -> Unit
}

/** Persisted separately from the framework so never-asked and permanently denied stay distinct. */
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
    SharedPreferencesPermissionRequestStore(activity),
    Dispatchers.Main.immediate,
  )

  private var closed = false
  private var finish: (() -> Unit)? = null
  override val changes: Flow<PrototypePermissionState> =
    gateway.resumes.filter { !closed && finish == null }.map { status() }.flowOn(dispatcher)

  override fun status(): PrototypePermissionState =
    if (closed || !gateway.foreground) PrototypePermissionState.UNAVAILABLE else authorization()

  private fun authorization(): PrototypePermissionState =
    when {
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

  override fun request(): Flow<PrototypePermissionOutcome> = callbackFlow {
    val current = status()
    if (finish != null) {
      trySend(PrototypePermissionOutcome.Busy)
      close()
      return@callbackFlow
    }
    if (
      current !in setOf(PrototypePermissionState.NOT_DETERMINED, PrototypePermissionState.DENIED)
    ) {
      trySend(PrototypePermissionOutcome.Status(current))
      close()
      return@callbackFlow
    }
    val end = {
      trySend(PrototypePermissionOutcome.Cancelled)
      close()
      Unit
    }
    finish = end
    try {
      store.asked = true
      val unregister = gateway.request {
        // Activity results can arrive before ON_RESUME; read authorization without the foreground
        // gate.
        trySend(PrototypePermissionOutcome.Status(authorization()))
        close()
      }
      awaitClose { unregister() }
    } finally {
      if (finish === end) finish = null
    }
  }
    .flowOn(dispatcher)

  override fun close() {
    closed = true
    finish?.invoke()
  }
}

private class SharedPreferencesPermissionRequestStore(context: Context) :
  PrototypePermissionRequestStore {
  private val preferences =
    context.getSharedPreferences("prototype.permissions", Context.MODE_PRIVATE)
  override var asked: Boolean
    get() = preferences.getBoolean("notifications.asked", false)
    set(value) {
      preferences.edit { putBoolean("notifications.asked", value) }
    }
}

private class FrameworkPermissionsGateway(private val activity: ComponentActivity) :
  AndroidPermissionsGateway {
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

  override fun request(deliver: () -> Unit): () -> Unit {
    val launcher =
      activity.activityResultRegistry.register(
        "prototype.notifications.${nextRequest.incrementAndGet()}",
        ActivityResultContracts.RequestPermission(),
      ) {
        deliver()
      }
    try {
      launcher.launch(POST_NOTIFICATIONS)
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      launcher.unregister()
      throw error
    }
    return { launcher.unregister() }
  }

  companion object {
    private val nextRequest = AtomicLong()
  }
}

// Manifest.permission.POST_NOTIFICATIONS, which only API 33 declares; used only on API 33+.
private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
