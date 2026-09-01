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
 * lives on the DI graph: the same lifecycle is attached to the shared [McpDaemonClient] (so
 * per-request preflights report through it) and run once at startup via [ensureReady] (so the first
 * launch installs/starts the daemon before the user has to trigger a request).
 */
class DaemonBootstrap
internal constructor(lifecycleFactory: ((DaemonLifecyclePhase) -> Unit) -> DaemonLifecycleEnsurer) {
  private val _state = MutableStateFlow<DaemonBootstrapState>(DaemonBootstrapState.Unknown)
  val state: StateFlow<DaemonBootstrapState> = _state.asStateFlow()

  internal val lifecycle: DaemonLifecycleEnsurer = lifecycleFactory(::onPhase)

  private fun onPhase(phase: DaemonLifecyclePhase) {
    _state.value =
      when (phase) {
        is DaemonLifecyclePhase.Completed -> DaemonBootstrapState.Ready(phase.restarted)
        is DaemonLifecyclePhase.Failed -> DaemonBootstrapState.Failed(phase.message)
        else -> DaemonBootstrapState.Working(phase)
      }
  }

  /**
   * Runs one lifecycle pass — detect the current daemon, or install Bun and start the pinned
   * package when none is reachable. Blocking (up to the daemon-startup budget); call on an IO
   * dispatcher. Progress and the terminal outcome land in [state] via the phase listener. Safe to
   * call again to retry a failure.
   */
  fun ensureReady() {
    lifecycle.ensureVersionMatchedDaemon()
  }

  /** Marks bootstrap as not applicable for this run (non-daemon transport). */
  internal fun markInactive() {
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
