package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("DesktopDaemonSessionComposition")
private const val HEARTBEAT_INTERVAL_MS = 2_000L

/**
 * Bind attempts per binding before a non-ownership failure is surfaced instead of retried (#10682).
 * A device still finishing cleanup or a CtrlProxy that is resuming usually succeeds within a few
 * heartbeat intervals; a device that is gone never does.
 */
internal const val MAX_BIND_ATTEMPTS = 3

data class DesktopDaemonSessionBinding(val deviceId: String, val platform: String)

data class DesktopDaemonSessionState(
  val session: DesktopDaemonSession?,
  val boundDeviceId: String?,
  val isRegistered: Boolean = false,
  /**
   * The picked device the daemon refused to bind because another session holds it (#10660). The
   * pane only views it (observer registration, no allocation) until the user calls
   * [requestControl]; the loop never re-sends the bind on its own, not even after the holder
   * releases the device.
   */
  val viewingDeviceId: String? = null,
  /** Explicit "Take control": exactly one bind attempt for the current binding (#10660). */
  val requestControl: () -> Unit = {},
  /**
   * Why binding the picked device failed after [MAX_BIND_ATTEMPTS] attempts, for a failure that is
   * not another session holding it (#10682): device not found, cleanup still running, a CtrlProxy
   * resume failure. The pane is not view-only; [requestControl] retries.
   */
  val bindErrorMessage: String? = null,
) {
  val sessionUuidProvider: () -> String?
    get() = session?.sessionUuidProvider ?: { null }
}

private val NO_SESSION_UUID: () -> String? = { null }

/**
 * The session provider handed to pane facets and the focused pane's control stream (#10231).
 *
 * [rememberDesktopDaemonSession] returns a NEW [DesktopDaemonSessionState] on every call, and the
 * type is unstable (it holds a [DesktopDaemonSession]), so a lambda written as `{
 * state.sessionUuidProvider() }` at the call site is rebuilt on every app-root recomposition — a
 * drag delta on a pane divider, a focus change, a tool toggle. The facets key their Logs telemetry
 * client, Performance and control observation streams and Failures push client on provider
 * identity, so each recomposition reconnected all of them.
 *
 * This provider's identity changes only with the session or its registration state, the two things
 * whose change SHOULD reconnect. A fresh wrapper per registration change (rather than the session's
 * own, never-changing provider) is deliberate: the registration flag is a plain `StateFlow`, not
 * Compose state, so a changed provider is what recomposes the facets so they re-read readiness.
 */
@Composable
fun rememberPaneSessionUuidProvider(state: DesktopDaemonSessionState): () -> String? {
  val session = state.session
  return remember(session, state.isRegistered) {
    val delegate = session?.sessionUuidProvider ?: NO_SESSION_UUID
    val provider: () -> String? = { delegate() }
    provider
  }
}

/** Owns the Compose-lifetime daemon session, binding, heartbeat recovery, and release. */
@Composable
fun rememberDesktopDaemonSession(
  socketPath: String?,
  binding: MutableState<DesktopDaemonSessionBinding?>,
  sessionFactory: (String) -> DesktopDaemonSession = { DesktopDaemonSession.create(it) },
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  cleanupDispatcher: CoroutineDispatcher = Dispatchers.IO,
  onDaemonRecovered: suspend () -> Boolean = { true },
): DesktopDaemonSessionState {
  // Bumped when the last pane closes while the session holds a device (#10659). Releasing a
  // session is terminal on the daemon (a reaped or released UUID cannot be reused), so the hold is
  // dropped by disposing this session and minting a fresh one, which registers deviceless and
  // re-binds on demand when a pane is focused again.
  var sessionEpoch by remember(socketPath) { mutableStateOf(0) }
  val session =
    remember(socketPath, sessionEpoch) {
      socketPath?.let {
        runCatching { sessionFactory(it) }
          .onFailure { error ->
            LOG.warn("Could not create desktop daemon session: ${error.message}")
          }
          .getOrNull()
      }
    }
  var boundDeviceId by remember(session) { mutableStateOf<String?>(null) }
  var viewingDeviceId by remember(session) { mutableStateOf<String?>(null) }
  var bindErrorMessage by remember(session) { mutableStateOf<String?>(null) }
  // Bumped only by an explicit "Take control" (#10660). It keys the binding effect, so each click
  // restarts it and makes exactly one fresh bind attempt.
  var controlRequests by remember(session) { mutableStateOf(0) }
  val requestControl: () -> Unit = remember(session) { { controlRequests++ } }
  val bindingMutex = remember(session) { Mutex() }
  val bindingGeneration = remember(session) { AtomicLong(0L) }

  DisposableEffect(session) {
    val cleanupScope = CoroutineScope(SupervisorJob() + cleanupDispatcher)
    onDispose {
      if (session != null) {
        cleanupScope.launch {
          runCatching { session.release() }
            .onFailure { error ->
              LOG.warn("Failed to release desktop daemon session: ${error.message}")
            }
          cleanupScope.cancel()
        }
      } else {
        cleanupScope.cancel()
      }
    }
  }

  LaunchedEffect(session, binding.value, controlRequests) {
    val generation = bindingGeneration.incrementAndGet()
    val target = binding.value
    boundDeviceId = null
    viewingDeviceId = null
    bindErrorMessage = null
    if (session == null) {
      boundDeviceId = target?.deviceId
      return@LaunchedEffect
    }

    if (target == null && session.holdsDevice) {
      // No pane observes the device any more: stop heartbeating it and release it by rotating
      // the session (the old one is released by the DisposableEffect above).
      sessionEpoch++
      return@LaunchedEffect
    }

    var refreshAfterRecovery = false
    var failureLogged = false
    // The daemon acknowledged this effect's binding (#10237). A healthy heartbeat cycle sends only
    // `daemon/heartbeat`; the binding is re-sent when a send failed or the heartbeat lapsed (a
    // daemon restart loses it). A changed binding restarts this effect, so it starts unbound.
    var bindingAcknowledged = false
    // The daemon answered this effect's bind with a refusal (#10660): another session holds the
    // device. The owner decision is non-exclusive viewing: register as an observer, keep
    // heartbeating, and never re-send the bind -- not on later ticks, not after a heartbeat lapse,
    // and not when the holder releases the device. Only a new binding or [requestControl] (both
    // restart this effect) tries again. A transport failure (thrown) is not a refusal and retries.
    // Only the daemon's ownership refusal counts (#10682); any other failed bind is retried up to
    // [MAX_BIND_ATTEMPTS] times and then surfaced as [bindErrorMessage], never as viewing.
    var refused = false
    var failedBinds = 0
    while (isActive && bindingGeneration.get() == generation) {
      val registered = runCatching {
        bindingMutex.withLock {
          if (bindingGeneration.get() != generation) return@LaunchedEffect
          withContext(ioDispatcher) {
            if (target == null || refused || failedBinds >= MAX_BIND_ATTEMPTS) {
              session.ensureRegistered()
            } else if (!bindingAcknowledged) {
              val result = session.client.setActiveDevice(target.deviceId, target.platform)
              when {
                result.success -> {
                  bindingAcknowledged = true
                  failedBinds = 0
                  session.deviceBound(held = true)
                }
                result.refusal == SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION -> {
                  refused = true
                  viewingDeviceId = target.deviceId
                  LOG.info(
                    "Device ${target.deviceId} is held by another session; viewing only: " +
                      "${result.message}"
                  )
                  session.ensureRegistered()
                }
                else -> {
                  failedBinds++
                  val message = result.message ?: "Failed to set active device"
                  // A bounded transient retry goes through the failure path below (delay, then
                  // retry the bind); the last attempt surfaces the error and keeps the session
                  // registered without the device.
                  check(failedBinds >= MAX_BIND_ATTEMPTS) {
                    "Binding ${target.deviceId} failed (attempt $failedBinds): $message"
                  }
                  LOG.warn("Could not bind ${target.deviceId}: $message")
                  bindErrorMessage = message
                  session.ensureRegistered()
                }
              }
            }
          }
        }
      }
        .onFailure { error ->
          if (error is CancellationException) throw error
          if (!failureLogged) {
            LOG.warn("Failed to register desktop session: ${error.message}")
            failureLogged = true
          }
        }
        .isSuccess
      if (bindingGeneration.get() != generation) return@LaunchedEffect
      if (!registered) {
        delay(HEARTBEAT_INTERVAL_MS)
        continue
      }

      failureLogged = false
      boundDeviceId = target?.deviceId?.takeIf { bindingAcknowledged }
      if (refreshAfterRecovery) {
        refreshAfterRecovery =
          !runCatching { onDaemonRecovered() }
            .onFailure { error ->
              LOG.warn("Failed to refresh state after daemon recovery: ${error.message}")
            }
            .getOrDefault(false)
      }
      val alive = runCatching {
        delay(HEARTBEAT_INTERVAL_MS)
        withContext(ioDispatcher) { session.heartbeat() }
      }
        .onFailure { error ->
          if (error is CancellationException) throw error
          LOG.warn("Desktop daemon session lapsed, re-registering: ${error.message}")
        }
        .isSuccess
      if (!alive) {
        refreshAfterRecovery = true
        bindingAcknowledged = false
        boundDeviceId = null
      }
    }
  }

  val registered = session?.isRegistered?.collectAsState()?.value ?: false
  return DesktopDaemonSessionState(
    session = session,
    boundDeviceId = boundDeviceId,
    isRegistered = registered,
    viewingDeviceId = viewingDeviceId,
    requestControl = requestControl,
    bindErrorMessage = bindErrorMessage,
  )
}
