package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull

internal val DESKTOP_DAEMON_COMPOSITION_LOG =
  LoggerFactory.getLogger("DesktopDaemonSessionComposition")
internal const val HEARTBEAT_INTERVAL_MS = 2_000L

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

/**
 * How long heartbeats may keep failing for a reason other than the daemon answering "session not
 * found" before a held device is treated as lost (#11072): the daemon's heartbeat lease plus its
 * grace. A shorter blip (a connect error, a daemon briefly busy or restarting its socket) keeps the
 * hold and retries on the next tick, since the daemon still holds the session.
 */
const val HEARTBEAT_LAPSE_MS = 8_000L

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
  DAEMON_RELEASED,
  /**
   * The user selected another device while recording this one (owner decision 2026-10-10, #11366):
   * its pane closed, which releases it and finalizes the recording.
   */
  DEVICE_SWITCH;

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
data class DesktopDaemonSessionOptions(
  val socketPath: String?,
  /** The devices visible panes show. Only one of these can be allocated. */
  val panes: State<List<DesktopDaemonSessionBinding>>,
  val sessionFactory: (String) -> DesktopDaemonSession = { DesktopDaemonSession.create(it) },
  val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  val cleanupDispatcher: CoroutineDispatcher = Dispatchers.IO,
  /**
   * Whether the user can see the host (#10695). After [hiddenReleaseGraceMs] hidden, the session
   * releases any device it holds and drops back to watching; showing the host again allocates
   * nothing until the user's next input.
   */
  val hostVisible: Boolean = true,
  val hiddenReleaseGraceMs: Long = HIDDEN_RELEASE_GRACE_MS,
  val inputAllocationTimeoutMs: Long = INPUT_ALLOCATION_TIMEOUT_MS,
  /**
   * The recording the desktop started. A hidden host does not release the device it is recording
   * (#10978): the hidden release is skipped, and the daemon's idle window frees the device later.
   */
  val activeRecordings: ActiveRecordingTracker? = null,
  val onDaemonRecovered: suspend () -> Boolean = { true },
  val bindRetryBackoff: BindRetryBackoff = BindRetryBackoff.Default,
  /** Monotonic milliseconds, for [HEARTBEAT_LAPSE_MS]; tests pass their virtual clock. */
  val monotonicClockMs: () -> Long = { System.nanoTime() / 1_000_000 },
)

@Composable
fun rememberDesktopDaemonSession(options: DesktopDaemonSessionOptions): DesktopDaemonSessionState {
  val state = remember(options.socketPath) { DesktopDaemonCompositionState() }
  val activeRecordings = options.activeRecordings ?: remember { ActiveRecordingTracker() }
  val session =
    remember(options.socketPath, state.sessionEpoch) {
      options.socketPath?.let {
        runCatching { options.sessionFactory(it) }
          .onFailure { error ->
            DESKTOP_DAEMON_COMPOSITION_LOG.warn(
              "Could not create desktop daemon session: ${error.message}",
            )
          }
          .getOrNull()
      }
    }
  state.currentSession = session
  val visiblePanes = options.panes.value
  state.currentPanes = visiblePanes
  state.HostVisibilityEffect(options, activeRecordings)
  state.VisiblePanesEffect(options, visiblePanes, activeRecordings)
  val requestInput = state.rememberRequestInput(options)
  val inputAllocation = state.rememberInputAllocation(options, requestInput)
  val requestControl = state.rememberRequestControl(options)
  val reportHeldElsewhere = state.rememberReportHeldElsewhere(options)
  val actions =
    DesktopSessionActions(requestInput, inputAllocation, requestControl, reportHeldElsewhere)
  val target =
    if (state.hiddenPastGrace) null
    else visiblePanes.firstOrNull { it.deviceId == state.inputDeviceId }
  state.CleanupEffect(options, session)
  state.BindingEffect(options, session, target)
  return state.renderState(session, actions)
}

internal class DesktopDaemonCompositionState {
  var sessionEpoch by mutableStateOf(0)
  var boundDeviceId by mutableStateOf<String?>(null)
  var bindErrorMessage by mutableStateOf<String?>(null)
  var bindErrorDeviceId by mutableStateOf<String?>(null)
  var inputDeviceId by mutableStateOf<String?>(null)
  var heldElsewhereDeviceId by mutableStateOf<String?>(null)
  var idleReleasedDeviceId by mutableStateOf<String?>(null)
  var releaseReason by mutableStateOf<SessionReleaseReason?>(null)
  var carriedBindError by mutableStateOf<Pair<String, String>?>(null)
  var controlRequests by mutableStateOf(0)
  var hiddenPastGrace by mutableStateOf(false)
  val pendingRecoveryRefresh = AtomicBoolean(false)
  val heldDevice = AtomicReference<String?>(null)
  val gates = InputAllocationGates()
  var currentSession by mutableStateOf<DesktopDaemonSession?>(null)
  var currentPanes by mutableStateOf<List<DesktopDaemonSessionBinding>>(emptyList())
}

private data class DesktopSessionActions(
  val requestInput: (String) -> Deferred<Boolean>,
  val inputAllocation: DesktopInputAllocation,
  val requestControl: (String) -> Unit,
  val reportHeldElsewhere: (String) -> Unit,
)

@Composable
private fun DesktopDaemonCompositionState.HostVisibilityEffect(
  options: DesktopDaemonSessionOptions,
  activeRecordings: ActiveRecordingTracker,
) {
  with(options) {
    LaunchedEffect(hostVisible, hiddenReleaseGraceMs) {
      if (hostVisible) {
        hiddenPastGrace = false
      } else {
        delay(hiddenReleaseGraceMs)
        if (inputDeviceId?.let(activeRecordings::isRecordingOn) == true) {
          // Releasing would stop the recording the user started; recording is not use, so the
          // daemon's idle window still frees the device eventually (#10978).
          DESKTOP_DAEMON_COMPOSITION_LOG.info(
            "Desktop host hidden while recording $inputDeviceId; keeping the device held",
          )
          return@LaunchedEffect
        }
        hiddenPastGrace = true
        // Nobody can see the device (#10695): stop holding it, as after an idle release. Showing
        // the
        // host again allocates nothing until the user's next input.
        inputDeviceId?.let { device ->
          DESKTOP_DAEMON_COMPOSITION_LOG.info(
            "Desktop host hidden; releasing $device until it is used again",
          )
          idleReleasedDeviceId = device
          releaseReason = SessionReleaseReason.HIDDEN_WINDOW
          inputDeviceId = null
        }
      }
    }
  }
}

@Composable
private fun DesktopDaemonCompositionState.VisiblePanesEffect(
  options: DesktopDaemonSessionOptions,
  visiblePanes: List<DesktopDaemonSessionBinding>,
  activeRecordings: ActiveRecordingTracker,
) {
  with(options) {
    LaunchedEffect(visiblePanes) {
      val visible = visiblePanes.map { it.deviceId }.toSet()
      inputDeviceId
        ?.takeIf { it !in visible && activeRecordings.isRecordingOn(it) }
        ?.let { recorded ->
          // Leaving a recorded device releases it and finalizes the recording (#11366): mark it
          // released, as an idle release does, so the dashboard fetches the artifact, drops Stop.
          idleReleasedDeviceId = recorded
          releaseReason = SessionReleaseReason.DEVICE_SWITCH
        }
      if (inputDeviceId != null && inputDeviceId !in visible) inputDeviceId = null
      if (heldElsewhereDeviceId != null && heldElsewhereDeviceId !in visible) {
        heldElsewhereDeviceId = null
      }
    }
  }
}

@Composable
private fun DesktopDaemonCompositionState.rememberRequestInput(
  options: DesktopDaemonSessionOptions,
): (String) -> Deferred<Boolean> {
  with(options) {
    return remember(socketPath) {
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
  }
}

@Composable
private fun DesktopDaemonCompositionState.rememberInputAllocation(
  options: DesktopDaemonSessionOptions,
  requestInput: (String) -> Deferred<Boolean>,
): DesktopInputAllocation {
  with(options) {
    return remember(socketPath, inputAllocationTimeoutMs) {
      DesktopInputAllocation { deviceId ->
        val gate = requestInput(deviceId)
        val allowed = runBlocking { withTimeoutOrNull(inputAllocationTimeoutMs) { gate.await() } }
        if (allowed == null) {
          DESKTOP_DAEMON_COMPOSITION_LOG.warn(
            "Allocating $deviceId for input timed out; dropping the input",
          )
        }
        allowed == true
      }
    }
  }
}

@Composable
private fun DesktopDaemonCompositionState.rememberRequestControl(
  options: DesktopDaemonSessionOptions,
): (String) -> Unit {
  with(options) {
    return remember(socketPath) {
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
  }
}

@Composable
private fun DesktopDaemonCompositionState.rememberReportHeldElsewhere(
  options: DesktopDaemonSessionOptions,
): (String) -> Unit {
  with(options) {
    return remember(socketPath) {
      { deviceId ->
        if (currentPanes.any { it.deviceId == deviceId }) {
          DESKTOP_DAEMON_COMPOSITION_LOG.info(
            "Device $deviceId is held by another session; watching only",
          )
          heldElsewhereDeviceId = deviceId
          // The daemon says this session does not hold it, whatever the last bind said: input stops
          // taking the no-wait path, and leaving the device lets the binding loop drop any hold.
          heldDevice.compareAndSet(deviceId, null)
          if (inputDeviceId == deviceId) inputDeviceId = null
        }
      }
    }
  }
}

@Composable
private fun DesktopDaemonCompositionState.CleanupEffect(
  options: DesktopDaemonSessionOptions,
  session: DesktopDaemonSession?,
) {
  with(options) {
    DisposableEffect(socketPath) { onDispose { gates.dropAllExcept(null) } }
    DisposableEffect(session) {
      val cleanupScope = CoroutineScope(SupervisorJob() + cleanupDispatcher)
      onDispose {
        if (session != null) {
          cleanupScope.launch {
            runCatching { session.release() }
              .onFailure { error ->
                DESKTOP_DAEMON_COMPOSITION_LOG.warn(
                  "Failed to release desktop daemon session: ${error.message}",
                )
              }
            cleanupScope.cancel()
          }
        } else {
          cleanupScope.cancel()
        }
      }
    }
  }
}

@Composable
private fun DesktopDaemonCompositionState.BindingEffect(
  options: DesktopDaemonSessionOptions,
  session: DesktopDaemonSession?,
  target: DesktopDaemonSessionBinding?,
) {
  with(options) {
    val bindingMutex = remember(session) { Mutex() }
    val bindingGeneration = remember(session) { AtomicLong(0L) }
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

      DesktopDaemonBinding(
          DesktopBindingContext(
            options,
            this@BindingEffect,
            session,
            target,
            bindingMutex,
            bindingGeneration,
            generation,
          ),
        )
        .run()
    }
  }
}

@Composable
private fun DesktopDaemonCompositionState.renderState(
  session: DesktopDaemonSession?,
  actions: DesktopSessionActions,
): DesktopDaemonSessionState {
  val registered = session?.isRegistered?.collectAsState()?.value ?: false
  return DesktopDaemonSessionState(
    session = session,
    boundDeviceId = boundDeviceId,
    isRegistered = registered,
    heldElsewhereDeviceId = heldElsewhereDeviceId,
    requestControl = actions.requestControl,
    bindErrorMessage = bindErrorMessage,
    bindErrorDeviceId = bindErrorDeviceId,
    idleReleasedDeviceId = idleReleasedDeviceId,
    releaseReason = releaseReason,
    requestInput = actions.requestInput,
    inputAllocation = actions.inputAllocation,
    reportHeldElsewhere = actions.reportHeldElsewhere,
  )
}
