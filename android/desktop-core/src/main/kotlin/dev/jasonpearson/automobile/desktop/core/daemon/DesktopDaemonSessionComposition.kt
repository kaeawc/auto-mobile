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
import java.util.concurrent.atomic.AtomicBoolean
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

/**
 * Cadence of the automatic single re-attempt while a bind error is surfaced and the pane stays open
 * (#10716), so a device that comes back needs no manual Retry. Slow on purpose: the error already
 * burned [MAX_BIND_ATTEMPTS] attempts, and each retry is a daemon round trip.
 */
internal const val BIND_ERROR_RETRY_INTERVAL_MS = 30_000L
private const val BIND_ERROR_RETRY_TICKS =
  (BIND_ERROR_RETRY_INTERVAL_MS / HEARTBEAT_INTERVAL_MS).toInt()

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
  /**
   * The picked device the daemon released from this desktop for inactivity (owner decision
   * 2026-10-08: 2 min after the last tool call). The pane keeps viewing it under a fresh, unbound
   * session and stays controllable; the first input on it ([onUserInteraction]) or [requestControl]
   * binds it again. The loop never re-binds it on its own, which would defeat the idle release.
   */
  val idleReleasedDeviceId: String? = null,
  /**
   * Called on the input dispatch path with the device a pane is about to drive. Re-binds an
   * [idleReleasedDeviceId] once; a no-op otherwise. Safe to call from any thread.
   */
  val onUserInteraction: (String) -> Unit = {},
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
  // Both survive a session rotation (keyed on the socket, not the session). The idle-released
  // device is viewed passively by the fresh session until the user interacts with it; a bind error
  // that forced a rotation (to drop a hold on another device) is carried so the fresh session
  // shows it instead of re-running the bounded retries.
  var idleReleasedDeviceId by remember(socketPath) { mutableStateOf<String?>(null) }
  var carriedBindError by remember(socketPath) { mutableStateOf<Pair<String, String>?>(null) }
  // Bumped only by an explicit "Take control" (#10660). It keys the binding effect, so each click
  // restarts it and makes exactly one fresh bind attempt.
  var controlRequests by remember(session) { mutableStateOf(0) }
  val requestControl: () -> Unit = remember(session) { { controlRequests++ } }
  val interactionResumed = remember(session) { AtomicBoolean(false) }
  val onUserInteraction: (String) -> Unit =
    remember(session) {
      { deviceId ->
        if (idleReleasedDeviceId == deviceId && interactionResumed.compareAndSet(false, true)) {
          controlRequests++
        }
      }
    }
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

    // A different pick, or an explicit Take control / pane input, ends the passive idle-released
    // view; only the same pick with no user action since the release stays passive.
    if (target?.deviceId != idleReleasedDeviceId || controlRequests > 0) {
      idleReleasedDeviceId = null
    }
    val passive = target != null && idleReleasedDeviceId == target.deviceId
    val carried = carriedBindError?.takeIf { it.first == target?.deviceId && controlRequests == 0 }
    carriedBindError = null

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
    var failedBinds = if (carried != null) MAX_BIND_ATTEMPTS else 0
    // Heartbeat ticks spent with a bind error surfaced; every [BIND_ERROR_RETRY_TICKS] allows one
    // more bind attempt (#10716). Counted in ticks, not wall time, so tests drive it with the
    // virtual clock.
    var ticksWithBindError = 0
    if (carried != null) bindErrorMessage = carried.second
    // This effect's binding was acknowledged and then lost to a heartbeat lapse, so the next bind
    // is
    // the loop re-sending it on its own, not a user action. If the daemon answers that the session
    // was released, it was idle-released: view passively instead of grabbing the device again.
    var lostAcknowledgedBind = false
    // Set when this session must be replaced by a fresh one before anything else happens: it still
    // holds a device the pane no longer controls (#10682 C3), or the daemon released its UUID
    // terminally (idle release, heartbeat expiry) so it can never bind again (C4).
    var rotateSession = false
    while (isActive && bindingGeneration.get() == generation) {
      val registered = runCatching {
        bindingMutex.withLock {
          if (bindingGeneration.get() != generation) return@LaunchedEffect
          withContext(ioDispatcher) {
            if (target == null || refused || passive || failedBinds >= MAX_BIND_ATTEMPTS) {
              session.ensureRegistered()
            } else if (!bindingAcknowledged) {
              val result = session.client.setActiveDevice(target.deviceId, target.platform)
              when {
                result.success -> {
                  bindingAcknowledged = true
                  lostAcknowledgedBind = false
                  failedBinds = 0
                  // A later bind succeeding (the device came back, the daemon restarted) clears
                  // a surfaced bind error without a Retry click.
                  bindErrorMessage = null
                  session.deviceBound(held = true)
                }
                result.refusal == SetActiveDeviceRefusal.SESSION_RELEASED -> {
                  // A released UUID is terminal on the daemon; re-sending it would fail forever,
                  // so the session is replaced by a fresh one. When the loop was re-sending a lost
                  // binding on its own, the daemon released the device for inactivity: the fresh
                  // session only views it until the user interacts. A user-initiated bind (new
                  // pick, Take control, pane input) binds under the fresh session.
                  val next =
                    if (lostAcknowledgedBind) {
                      idleReleasedDeviceId = target.deviceId
                      "viewing ${target.deviceId} under a fresh session until it is used again"
                    } else {
                      "binding ${target.deviceId} under a fresh session"
                    }
                  LOG.info(
                    "Desktop session ${session.sessionUuid} was released by the daemon; " +
                      "$next: ${result.message}",
                  )
                  rotateSession = true
                }
                result.refusal == SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION &&
                  session.holdsDevice -> {
                  // The daemon refused before rebinding, so this session still holds the device
                  // it bound earlier while the pane would only view the new pick. Release that
                  // hold by rotating the session; the fresh session views the pick passively.
                  LOG.info(
                    "Device ${target.deviceId} is held by another session; releasing the " +
                      "previously bound device before viewing it",
                  )
                  rotateSession = true
                }
                result.refusal == SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION -> {
                  refused = true
                  viewingDeviceId = target.deviceId
                  LOG.info(
                    "Device ${target.deviceId} is held by another session; viewing only: " +
                      "${result.message}",
                  )
                  session.ensureRegistered()
                }
                else -> {
                  failedBinds++
                  val message = result.message ?: "Failed to set active device"
                  when {
                    failedBinds < MAX_BIND_ATTEMPTS -> {
                      // A bounded transient retry: stay registered (streams keep authenticating
                      // with this UUID) and re-send the bind on the next heartbeat tick.
                      LOG.info(
                        "Binding ${target.deviceId} failed (attempt $failedBinds of " +
                          "$MAX_BIND_ATTEMPTS), retrying: $message",
                      )
                      session.ensureRegistered()
                    }
                    session.holdsDevice -> {
                      // The daemon refused before rebinding, so this session still holds the
                      // device it bound earlier, which an unusable pane would keep from everyone
                      // else until the idle window. Drop that hold by rotating the session; the
                      // fresh session shows this error without holding anything.
                      LOG.warn(
                        "Could not bind ${target.deviceId}: $message; releasing the previously " +
                          "bound device",
                      )
                      carriedBindError = target.deviceId to message
                      rotateSession = true
                    }
                    else -> {
                      LOG.warn("Could not bind ${target.deviceId}: $message")
                      bindErrorMessage = message
                      session.ensureRegistered()
                    }
                  }
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
      if (rotateSession) {
        sessionEpoch++
        return@LaunchedEffect
      }
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
      if (alive && failedBinds >= MAX_BIND_ATTEMPTS && bindErrorMessage != null) {
        ticksWithBindError++
        if (ticksWithBindError >= BIND_ERROR_RETRY_TICKS) {
          // One attempt: a failure puts the count straight back to the cap and keeps the message.
          ticksWithBindError = 0
          failedBinds = MAX_BIND_ATTEMPTS - 1
        }
      } else {
        ticksWithBindError = 0
      }
      if (!alive) {
        refreshAfterRecovery = true
        if (bindingAcknowledged) lostAcknowledgedBind = true
        bindingAcknowledged = false
        boundDeviceId = null
        // A surfaced bind error is retried once the session re-registers after a lapse (a daemon
        // restart may have brought the device back); a success clears it.
        if (failedBinds >= MAX_BIND_ATTEMPTS) failedBinds = 0
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
    idleReleasedDeviceId = idleReleasedDeviceId,
    onUserInteraction = onUserInteraction,
  )
}
