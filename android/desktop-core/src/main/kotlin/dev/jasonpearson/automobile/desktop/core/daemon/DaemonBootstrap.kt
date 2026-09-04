package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Observable daemon-bootstrap state for the launch surfaces. A projection of every
 * [DaemonLifecyclePhase] the shared [DesktopDaemonLifecycle] reports — whether the pass was
 * triggered by the explicit startup bootstrap or by a per-request preflight — so the UI always
 * reflects the pass that is actually holding the lifecycle lock.
 */
sealed interface DaemonBootstrapState {
  /**
   * Bootstrap does not apply: the app talks to an HTTP/STDIO transport it neither installs nor
   * launches.
   */
  data object Inactive : DaemonBootstrapState

  /** No lifecycle pass has reported yet (app just launched). */
  data object Unknown : DaemonBootstrapState

  /** A lifecycle pass is in flight; [phase] narrates what it is doing. */
  data class Working(val phase: DaemonLifecyclePhase) : DaemonBootstrapState

  /** The last pass resolved with a ready daemon. */
  data class Ready(val restarted: Boolean) : DaemonBootstrapState

  /** The last pass resolved without a usable daemon. */
  data class Failed(val message: String) : DaemonBootstrapState
}

/**
 * Owns the app-wide [DesktopDaemonLifecycle] and exposes its progress as [state]. One instance
 * lives on the DI graph, and the same lifecycle is attached to the shared [McpDaemonClient], so
 * per-request preflights report through it — the picker's first load is what runs the startup
 * install/start pass. [ensureReady] exists for explicit triggers (e.g. a future recovery
 * affordance); the app deliberately does NOT also call it at startup, since a second queued pass
 * behind the lifecycle lock would repeat a failed install/start pipeline for another full startup
 * timeout.
 */
class DaemonBootstrap
internal constructor(lifecycleFactory: ((DaemonLifecyclePhase) -> Unit) -> DaemonLifecycleEnsurer) {
  private val _state = MutableStateFlow<DaemonBootstrapState>(DaemonBootstrapState.Unknown)
  val state: StateFlow<DaemonBootstrapState> = _state.asStateFlow()

  internal val lifecycle: DaemonLifecycleEnsurer = lifecycleFactory(::onPhase)

  // Latched by markInactive: a configured non-daemon transport (HTTP/STDIO) neither installs nor
  // launches the local daemon, so ensureReady must be a no-op — otherwise the app-startup effect
  // would run the real lifecycle anyway, installing Bun and starting/restarting an unused Unix
  // daemon, and its phases would overwrite the Inactive state.
  @Volatile private var inactive = false

  private fun onPhase(phase: DaemonLifecyclePhase) {
    if (inactive) return
    _state.value =
      when (phase) {
        is DaemonLifecyclePhase.Completed -> DaemonBootstrapState.Ready(phase.restarted)
        is DaemonLifecyclePhase.Failed -> DaemonBootstrapState.Failed(phase.message)
        else -> DaemonBootstrapState.Working(phase)
      }
  }

  /**
   * Runs one recovery lifecycle pass — detect the current daemon, install Bun and start the pinned
   * package when none is reachable, OR restart a socket-open-but-wedged daemon whose `ide/status`
   * probe fails (#6082). This is the shared recovery primitive behind BOTH the workspace status-dot
   * "Start daemon" button and the device-picker Retry, so both un-stick a wedged daemon rather than
   * short-circuiting on the open socket. Blocking (up to the daemon-startup budget); call on an IO
   * dispatcher. Progress and the terminal outcome land in [state] via the phase listener. Safe to
   * call again to retry a failure. A no-op for an [markInactive]-marked bootstrap (non-daemon
   * transport) — the app must never install/start a local daemon it is not connected to.
   */
  fun ensureReady() {
    if (inactive) return
    lifecycle.ensureHealthyDaemon()
  }

  /**
   * Installs the protocol-health probe that [ensureReady] uses to tell a wedged daemon from a
   * reachable one. Wired once the daemon client exists (the client supplies the `ide/status` call
   * the probe issues), so it cannot be a constructor dependency of the lifecycle the client is
   * built around.
   */
  internal fun attachHealthProbe(probe: DaemonHealthProbe) {
    lifecycle.attachHealthProbe(probe)
  }

  /** Marks bootstrap as not applicable for this run (non-daemon transport). */
  internal fun markInactive() {
    inactive = true
    _state.value = DaemonBootstrapState.Inactive
  }

  companion object {
    fun create(): DaemonBootstrap = DaemonBootstrap { listener ->
      DesktopDaemonLifecycle(phaseListener = listener)
    }

    /**
     * An inert instance whose lifecycle never touches the system — for test graphs and non-daemon
     * transports. Its state is permanently [DaemonBootstrapState.Inactive].
     */
    fun inactive(): DaemonBootstrap = DaemonBootstrap {
      object : DaemonLifecycleEnsurer {
        override fun ensureVersionMatchedDaemon(): DaemonLifecycleResult =
          DaemonLifecycleResult.Failure("Daemon bootstrap is inactive.")
      }
    }
      .apply { markInactive() }
  }
}
