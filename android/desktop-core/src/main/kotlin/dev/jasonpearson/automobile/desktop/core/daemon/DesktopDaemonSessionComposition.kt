package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

private val LOG = LoggerFactory.getLogger("DesktopDaemonSessionComposition")
private const val HEARTBEAT_INTERVAL_MS = 2_000L

/**
 * Bind attempts per binding before a non-ownership failure is surfaced instead of retried (#10682).
 * A device still finishing cleanup or a CtrlProxy that is resuming usually succeeds within a few
 * heartbeat intervals; a device that is gone never does.
 */
internal const val MAX_BIND_ATTEMPTS = 3

/**
 * Ceiling of the delay before the automatic single re-attempt while a bind error is surfaced and
 * the pane stays open (#10716), so a device that comes back needs no manual Retry. Slow on purpose:
 * the error already burned [MAX_BIND_ATTEMPTS] attempts, and each retry is a daemon round trip.
 */
internal const val BIND_ERROR_RETRY_MAX_DELAY_MS = 30_000L

/**
 * Delay before the [retry]th (0-based) automatic re-attempt of a surfaced bind error (#10832). The
 * default backs off exponentially with jitter up to [BIND_ERROR_RETRY_MAX_DELAY_MS]; tests inject a
 * deterministic one.
 */
fun interface BindRetryBackoff {
  fun delayMs(retry: Int): Long

  companion object {
    val Default = BindRetryBackoff { retry ->
      RetryPolicy(initialDelayMs = 5_000L, maxDelayMs = BIND_ERROR_RETRY_MAX_DELAY_MS)
        .delayBeforeRetryMs(retry)
    }
  }
}

/**
 * How long the host (the desktop window, the IDE tool window) may stay hidden before the session
 * releases the device it holds (#10695). Short enough that a window closed to the tray stops
 * holding a device nobody is looking at; long enough that a quick hide/show or a tool-window toggle
 * does not churn the session.
 */
const val HIDDEN_RELEASE_GRACE_MS = 10_000L

/**
 * How long an input waits for the desktop session to allocate its device before the input is
 * dropped (#10730). A healthy `setActiveDevice` takes milliseconds; a CtrlProxy resume can take a
 * few seconds. Past this the input is shed so the pane's single dispatch thread is not held.
 */
const val INPUT_ALLOCATION_TIMEOUT_MS = 10_000L

/** A device a visible pane shows, and the platform `setActiveDevice` needs to allocate it. */
data class DesktopDaemonSessionBinding(val deviceId: String, val platform: String)

/**
 * Allocates a device to the desktop session before input reaches it (#10730, owner decisions
 * 2026-10-08: desktop input is active tool use; watching is not).
 *
 * Watching a device allocates nothing. The first input on a free device allocates it with
 * `setActiveDevice`, and only then is the input sent. Input on a device another session holds is
 * refused, and nothing retries or grabs it.
 */
fun interface DesktopInputAllocation {
  /**
   * Blocks until the desktop session holds [deviceId] (true), or the allocation was refused, failed
   * or timed out (false: drop the input). Call it on an input dispatch thread, never the UI thread.
   */
  fun awaitInputAllowed(deviceId: String): Boolean

  companion object {
    /** No daemon session to allocate under (a non-Unix transport): input is never gated. */
    val Unrestricted = DesktopInputAllocation { true }
  }
}

/**
 * Why the session stopped holding a device the user was not leaving (#10695, #10730). The daemon
 * names the reason on its session-not-found answer to a heartbeat (`releaseReason`); an older
 * daemon, or a UUID it never issued, sends none, which is [DAEMON_RELEASED].
 */
enum class SessionReleaseReason {
  /** The host stayed hidden past [HIDDEN_RELEASE_GRACE_MS], so this desktop released it. */
  HIDDEN_WINDOW,
  /** The session sat idle past the daemon's window (2 minutes without a tool call or input). */
  IDLE,
  /** The daemon stopped hearing this session's heartbeats, or its owner connection closed. */
  HEARTBEAT_LAPSED,
  /** The daemon restarted (or the device restarted) and did not restore the session. */
  DAEMON_RESTARTED,
  /** The daemon no longer had the session's hold, for a reason it did not say. */
  DAEMON_RELEASED;

  companion object {
    /** Maps the daemon's `releaseReason` string (`src/daemon/sessionManager.ts`) to a notice. */
    fun fromDaemon(daemonReason: String?): SessionReleaseReason =
      when {
        daemonReason == null -> DAEMON_RELEASED
        daemonReason in IDLE_DAEMON_REASONS -> IDLE
        daemonReason in LAPSED_DAEMON_REASONS -> HEARTBEAT_LAPSED
        daemonReason == "daemon-shutdown" || daemonReason.startsWith("device-restart") ->
          DAEMON_RESTARTED
        else -> DAEMON_RELEASED
      }

    private val IDLE_DAEMON_REASONS =
      setOf("cleanup-expired", "lazy-expiry", "cli-idle-timeout", "idle", "autolock", "expired")
    private val LAPSED_DAEMON_REASONS =
      setOf("heartbeat-timeout", "missing-first-heartbeat", "owner-disconnected")
  }
}

data class DesktopDaemonSessionState(
  val session: DesktopDaemonSession?,
  /** The device the session holds: the one the user last sent input to, while its pane shows. */
  val boundDeviceId: String?,
  val isRegistered: Boolean = false,
  /**
   * The device whose input was refused because another session holds it (#10660, #10730). Its pane
   * keeps watching and shows who controls the device. Later input on it is dropped without a bind;
   * only [requestControl] tries again, once. Every other pane, and this one before any input, is
   * plain watching, which needs no notice.
   */
  val heldElsewhereDeviceId: String? = null,
  /** Explicit "Take control" or "Retry" for a pane's device: exactly one fresh bind attempt. */
  val requestControl: (String) -> Unit = {},
  /**
   * Why allocating [bindErrorDeviceId] failed after [MAX_BIND_ATTEMPTS] attempts, for a failure
   * that is not another session holding it (#10682): device not found, cleanup still running, a
   * CtrlProxy resume failure. [requestControl] retries.
   */
  val bindErrorMessage: String? = null,
  val bindErrorDeviceId: String? = null,
  /**
   * The device the session stopped holding without the user leaving it: the daemon released it
   * after the idle window (owner decision 2026-10-08), the daemon restarted, the session expired,
   * or the host stayed hidden past [HIDDEN_RELEASE_GRACE_MS]. The pane drops back to watching and
   * the session never re-acquires it on its own; the next input allocates it again.
   */
  val idleReleasedDeviceId: String? = null,
  /** Why [idleReleasedDeviceId] was released, for the pane's notice (#10730). */
  val releaseReason: SessionReleaseReason? = null,
  /**
   * Starts (or joins) allocating a device for input without blocking. The result completes true
   * once the session holds the device, false when the input must be dropped. Safe from any thread.
   */
  val requestInput: (String) -> Deferred<Boolean> = { CompletableDeferred(true) },
  /** The blocking form of [requestInput] that input clients wait on (#10730). */
  val inputAllocation: DesktopInputAllocation = DesktopInputAllocation.Unrestricted,
  /**
   * The daemon refused an input or device control on this device because another session holds it
   * (`device_owned_by_other_session`, #10743, #10783): show the pane's held-elsewhere notice, as a
   * refused bind does, and stop treating the device as held by this session. Also how a transport
   * with no desktop session (MCP HTTP/STDIO) makes a refusal visible. Ignored for a device no pane
   * shows. Safe from any thread.
   */
  val reportHeldElsewhere: (String) -> Unit = {},
) {
  val sessionUuidProvider: () -> String?
    get() = session?.sessionUuidProvider ?: { null }
}

/** Pending input allocations by device id; each completes once with the allocation outcome. */
internal class InputAllocationGates {
  private val pending = HashMap<String, CompletableDeferred<Boolean>>()

  @Synchronized
  fun join(deviceId: String): CompletableDeferred<Boolean> =
    pending.getOrPut(deviceId) { CompletableDeferred() }

  @Synchronized
  fun complete(deviceId: String, allowed: Boolean) {
    pending.remove(deviceId)?.complete(allowed)
  }

  /** Drops every pending input except [deviceId]'s (all of them when null). */
  @Synchronized
  fun dropAllExcept(deviceId: String?) {
    val dropped = pending.keys.filter { it != deviceId }
    dropped.forEach { pending.remove(it)?.complete(false) }
  }
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

/**
 * Owns the Compose-lifetime daemon session, device allocation, heartbeat recovery, and release.
 *
 * The session registers as an observer and allocates nothing while the user only watches (#10730).
 * The device the user last sent input to is allocated (`setActiveDevice`) on that input, held while
 * its pane is among [panes] and the host is visible, and released by rotating the session when it
 * is not. When the daemon drops the hold (idle release, restart, expiry) the session drops back to
 * watching under a fresh UUID and never re-acquires the device on its own.
 */
@Composable
fun rememberDesktopDaemonSession(
  socketPath: String?,
  /** The devices visible panes show. Only one of these can be allocated. */
  panes: State<List<DesktopDaemonSessionBinding>>,
  sessionFactory: (String) -> DesktopDaemonSession = { DesktopDaemonSession.create(it) },
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  cleanupDispatcher: CoroutineDispatcher = Dispatchers.IO,
  /**
   * Whether the user can see the host (#10695). After [hiddenReleaseGraceMs] hidden, the session
   * releases any device it holds and drops back to watching; showing the host again allocates
   * nothing until the user's next input.
   */
  hostVisible: Boolean = true,
  hiddenReleaseGraceMs: Long = HIDDEN_RELEASE_GRACE_MS,
  inputAllocationTimeoutMs: Long = INPUT_ALLOCATION_TIMEOUT_MS,
  /**
   * The recording the desktop started. A hidden host does not release the device it is recording
   * (#10978): the hidden release is skipped, and the daemon's idle window frees the device later.
   */
  activeRecordings: ActiveRecordingTracker = remember { ActiveRecordingTracker() },
  onDaemonRecovered: suspend () -> Boolean = { true },
  bindRetryBackoff: BindRetryBackoff = BindRetryBackoff.Default,
): DesktopDaemonSessionState {
  // Bumped to replace the session with a fresh one (#10659). Releasing a session is how a hold is
  // dropped, and a released UUID is terminal on the daemon, so the fresh one registers as an
  // observer and allocates only on the next input.
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
  // Everything below survives a session rotation (keyed on the socket); the binding effect resets
  // the per-session parts when it restarts.
  var boundDeviceId by remember(socketPath) { mutableStateOf<String?>(null) }
  var bindErrorMessage by remember(socketPath) { mutableStateOf<String?>(null) }
  var bindErrorDeviceId by remember(socketPath) { mutableStateOf<String?>(null) }
  // The device the user last sent input to (or asked to control): the only device ever allocated.
  var inputDeviceId by remember(socketPath) { mutableStateOf<String?>(null) }
  var heldElsewhereDeviceId by remember(socketPath) { mutableStateOf<String?>(null) }
  var idleReleasedDeviceId by remember(socketPath) { mutableStateOf<String?>(null) }
  var releaseReason by remember(socketPath) { mutableStateOf<SessionReleaseReason?>(null) }
  // A bind error that forced a rotation (to drop a hold on another device) is carried so the fresh
  // session shows it instead of re-running the bounded retries.
  var carriedBindError by remember(socketPath) { mutableStateOf<Pair<String, String>?>(null) }
  // Bumped only by an explicit Take control / Retry (#10660). It keys the binding effect, so each
  // click restarts it and makes exactly one fresh bind attempt.
  var controlRequests by remember(socketPath) { mutableStateOf(0) }
  var hiddenPastGrace by remember(socketPath) { mutableStateOf(false) }
  // A lapse rotated the session: the fresh session runs the daemon-recovery refresh once.
  val pendingRecoveryRefresh = remember(socketPath) { AtomicBoolean(false) }
  // The device the current session holds, read on input threads for the no-wait fast path.
  val heldDevice = remember(socketPath) { AtomicReference<String?>(null) }
  val gates = remember(socketPath) { InputAllocationGates() }
  val currentSession by rememberUpdatedState(session)
  val visiblePanes = panes.value
  val currentPanes by rememberUpdatedState(visiblePanes)

  LaunchedEffect(hostVisible, hiddenReleaseGraceMs) {
    if (hostVisible) {
      hiddenPastGrace = false
    } else {
      delay(hiddenReleaseGraceMs)
      if (inputDeviceId?.let(activeRecordings::isRecordingOn) == true) {
        // Releasing would stop the recording the user started; recording is not use, so the
        // daemon's idle window still frees the device eventually (#10978).
        LOG.info("Desktop host hidden while recording $inputDeviceId; keeping the device held")
        return@LaunchedEffect
      }
      hiddenPastGrace = true
      // Nobody can see the device (#10695): stop holding it, as after an idle release. Showing the
      // host again allocates nothing until the user's next input.
      inputDeviceId?.let { device ->
        LOG.info("Desktop host hidden; releasing $device until it is used again")
        idleReleasedDeviceId = device
        releaseReason = SessionReleaseReason.HIDDEN_WINDOW
        inputDeviceId = null
      }
    }
  }
  // A closed pane stops holding its device (#10659), and its refusal notice goes with it.
  LaunchedEffect(visiblePanes) {
    val visible = visiblePanes.map { it.deviceId }.toSet()
    if (inputDeviceId != null && inputDeviceId !in visible) inputDeviceId = null
    if (heldElsewhereDeviceId != null && heldElsewhereDeviceId !in visible) {
      heldElsewhereDeviceId = null
    }
  }

  val requestInput: (String) -> Deferred<Boolean> =
    remember(socketPath) {
      { deviceId ->
        when {
          currentSession == null -> CompletableDeferred(true)
          heldDevice.get() == deviceId -> CompletableDeferred(true)
          hiddenPastGrace || currentPanes.none { it.deviceId == deviceId } ->
            CompletableDeferred(false)
          // Another session holds it: the pane keeps watching, and nothing retries or grabs.
          heldElsewhereDeviceId == deviceId -> CompletableDeferred(false)
          // A surfaced bind error is retried on its own cadence or by Retry, not per input.
          bindErrorDeviceId == deviceId -> CompletableDeferred(false)
          else ->
            gates.join(deviceId).also {
              if (idleReleasedDeviceId != null) {
                idleReleasedDeviceId = null
                releaseReason = null
              }
              if (inputDeviceId != deviceId) inputDeviceId = deviceId
            }
        }
      }
    }
  val inputAllocation =
    remember(socketPath, inputAllocationTimeoutMs) {
      DesktopInputAllocation { deviceId ->
        val gate = requestInput(deviceId)
        val allowed = runBlocking { withTimeoutOrNull(inputAllocationTimeoutMs) { gate.await() } }
        if (allowed == null) {
          LOG.warn("Allocating $deviceId for input timed out; dropping the input")
        }
        allowed == true
      }
    }
  val requestControl: (String) -> Unit =
    remember(socketPath) {
      { deviceId ->
        if (currentPanes.any { it.deviceId == deviceId }) {
          if (heldElsewhereDeviceId == deviceId) heldElsewhereDeviceId = null
          idleReleasedDeviceId = null
          releaseReason = null
          carriedBindError = null
          inputDeviceId = deviceId
          controlRequests++
        }
      }
    }
  val reportHeldElsewhere: (String) -> Unit =
    remember(socketPath) {
      { deviceId ->
        if (currentPanes.any { it.deviceId == deviceId }) {
          LOG.info("Device $deviceId is held by another session; watching only")
          heldElsewhereDeviceId = deviceId
          // The daemon says this session does not hold it, whatever the last bind said: input stops
          // taking the no-wait path, and leaving the device lets the binding loop drop any hold.
          heldDevice.compareAndSet(deviceId, null)
          if (inputDeviceId == deviceId) inputDeviceId = null
        }
      }
    }
  val target =
    if (hiddenPastGrace) null else visiblePanes.firstOrNull { it.deviceId == inputDeviceId }

  val bindingMutex = remember(session) { Mutex() }
  val bindingGeneration = remember(session) { AtomicLong(0L) }

  DisposableEffect(socketPath) { onDispose { gates.dropAllExcept(null) } }
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

  LaunchedEffect(session, target, controlRequests) {
    val generation = bindingGeneration.incrementAndGet()
    boundDeviceId = null
    bindErrorMessage = null
    bindErrorDeviceId = null
    heldDevice.set(null)
    // Input waiting on a device that is no longer the one to allocate is dropped.
    gates.dropAllExcept(target?.deviceId)
    if (session == null) {
      boundDeviceId = target?.deviceId
      target?.let { gates.complete(it.deviceId, allowed = true) }
      return@LaunchedEffect
    }

    if (target == null && session.holdsDevice) {
      // The user left the device (its pane closed, the host hid, the hold lapsed): release it by
      // rotating the session (the old one is released by the DisposableEffect above).
      sessionEpoch++
      return@LaunchedEffect
    }

    val carried = carriedBindError?.takeIf { it.first == target?.deviceId }
    carriedBindError = null

    var refreshAfterRecovery = pendingRecoveryRefresh.getAndSet(false)
    var failureLogged = false
    // The daemon acknowledged this effect's bind (#10237). A healthy heartbeat cycle sends only
    // `daemon/heartbeat`; a changed target restarts this effect, so it starts unbound.
    var bindingAcknowledged = false
    // Only the daemon's ownership refusal counts as held elsewhere (#10682); any other failed bind
    // is retried up to [MAX_BIND_ATTEMPTS] times and then surfaced as [bindErrorMessage].
    var failedBinds = if (carried != null) MAX_BIND_ATTEMPTS else 0
    // Heartbeat ticks spent with a bind error surfaced; every [BIND_ERROR_RETRY_TICKS] allows one
    // more bind attempt (#10716). Counted in ticks, not wall time, so tests drive it with the
    // virtual clock.
    var ticksWithBindError = 0
    // Automatic re-attempts spent on this error (the backoff index), and the tick count the current
    // wait needs (-1 until chosen). Both reset once a bind succeeds.
    var bindErrorRetries = 0
    var bindErrorWaitTicks = -1
    if (carried != null) {
      bindErrorMessage = carried.second
      bindErrorDeviceId = carried.first
    }
    // Set when this session must be replaced by a fresh one before anything else happens: it still
    // holds a device the user no longer drives (#10682 C3), or the daemon released its UUID
    // terminally so it can never bind again (C4).
    var rotateSession = false
    while (isActive && bindingGeneration.get() == generation) {
      val registered = runCatching {
        bindingMutex.withLock {
          if (bindingGeneration.get() != generation) return@LaunchedEffect
          withContext(ioDispatcher) {
            when {
              target == null -> session.ensureRegistered()
              heldElsewhereDeviceId == target.deviceId || failedBinds >= MAX_BIND_ATTEMPTS -> {
                session.ensureRegistered()
                gates.complete(target.deviceId, allowed = false)
              }
              bindingAcknowledged -> gates.complete(target.deviceId, allowed = true)
              else -> {
                val result = session.client.setActiveDevice(target.deviceId, target.platform)
                when {
                  result.success -> {
                    bindingAcknowledged = true
                    failedBinds = 0
                    bindErrorRetries = 0
                    // A later bind succeeding (the device came back) clears a surfaced bind error
                    // without a Retry click.
                    bindErrorMessage = null
                    bindErrorDeviceId = null
                    session.deviceBound(held = true)
                    heldDevice.set(target.deviceId)
                    gates.complete(target.deviceId, allowed = true)
                  }
                  result.refusal == SetActiveDeviceRefusal.SESSION_RELEASED -> {
                    // A released UUID is terminal on the daemon; re-sending it would fail
                    // forever. The input is the user's, so the fresh session allocates the
                    // device, and the waiting input goes through once it does.
                    LOG.info(
                      "Desktop session ${session.sessionUuid} was released by the daemon; " +
                        "allocating ${target.deviceId} under a fresh session: ${result.message}",
                    )
                    rotateSession = true
                  }
                  result.refusal == SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION -> {
                    heldElsewhereDeviceId = target.deviceId
                    gates.complete(target.deviceId, allowed = false)
                    LOG.info(
                      "Device ${target.deviceId} is held by another session; watching only: " +
                        "${result.message}",
                    )
                    if (session.holdsDevice) {
                      // The daemon refused before rebinding, so this session still holds the
                      // device the user drove before. Release that hold by rotating the session.
                      rotateSession = true
                    } else {
                      session.ensureRegistered()
                    }
                  }
                  else -> {
                    failedBinds++
                    // The input is dropped; the bounded retries below run without it.
                    gates.complete(target.deviceId, allowed = false)
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
                          "Could not bind ${target.deviceId}: $message; releasing the " +
                            "previously bound device",
                        )
                        carriedBindError = target.deviceId to message
                        rotateSession = true
                      }
                      else -> {
                        LOG.warn("Could not bind ${target.deviceId}: $message")
                        bindErrorMessage = message
                        bindErrorDeviceId = target.deviceId
                        session.ensureRegistered()
                      }
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
          // A transport failure is not a refusal: drop the input, and retry on the next tick.
          if (!bindingAcknowledged) target?.let { gates.complete(it.deviceId, allowed = false) }
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
      var lapse: Throwable? = null
      val alive = runCatching {
        delay(HEARTBEAT_INTERVAL_MS)
        withContext(ioDispatcher) { session.heartbeat() }
      }
        .onFailure { error ->
          if (error is CancellationException) throw error
          lapse = error
          LOG.warn("Desktop daemon session lapsed, re-registering: ${error.message}")
        }
        .isSuccess
      if (alive && failedBinds >= MAX_BIND_ATTEMPTS && bindErrorMessage != null) {
        if (bindErrorWaitTicks < 0) {
          val delayMs = bindRetryBackoff.delayMs(bindErrorRetries)
          bindErrorWaitTicks =
            ((delayMs + HEARTBEAT_INTERVAL_MS - 1) / HEARTBEAT_INTERVAL_MS).toInt()
        }
        ticksWithBindError++
        if (ticksWithBindError >= bindErrorWaitTicks) {
          // One attempt: a failure puts the count straight back to the cap and keeps the message.
          ticksWithBindError = 0
          bindErrorWaitTicks = -1
          bindErrorRetries++
          failedBinds = MAX_BIND_ATTEMPTS - 1
        }
      } else {
        ticksWithBindError = 0
        bindErrorWaitTicks = -1
      }
      if (!alive && bindingAcknowledged && target != null) {
        // The daemon no longer has this session's hold: it idle-released it after the idle window
        // (owner decision 2026-10-08), restarted, or expired the session. Drop back to watching
        // under a fresh session and never re-acquire the device on our own (#10730): only the
        // user's next input allocates it again.
        LOG.info(
          "Desktop session ${session.sessionUuid} lost ${target.deviceId}; watching it under a " +
            "fresh session until it is used again",
        )
        heldDevice.set(null)
        idleReleasedDeviceId = target.deviceId
        releaseReason =
          SessionReleaseReason.fromDaemon((lapse as? DaemonSessionNotFoundException)?.releaseReason)
        inputDeviceId = null
        pendingRecoveryRefresh.set(true)
        sessionEpoch++
        return@LaunchedEffect
      }
      if (!alive) {
        refreshAfterRecovery = true
        boundDeviceId = null
        // A surfaced bind error is retried once the session re-registers after a lapse (a daemon
        // restart may have brought the device back); a success clears it.
        if (failedBinds >= MAX_BIND_ATTEMPTS) failedBinds = 0
        bindErrorRetries = 0
      }
    }
  }

  val registered = session?.isRegistered?.collectAsState()?.value ?: false
  return DesktopDaemonSessionState(
    session = session,
    boundDeviceId = boundDeviceId,
    isRegistered = registered,
    heldElsewhereDeviceId = heldElsewhereDeviceId,
    requestControl = requestControl,
    bindErrorMessage = bindErrorMessage,
    bindErrorDeviceId = bindErrorDeviceId,
    idleReleasedDeviceId = idleReleasedDeviceId,
    releaseReason = releaseReason,
    requestInput = requestInput,
    inputAllocation = inputAllocation,
    reportHeldElsewhere = reportHeldElsewhere,
  )
}
