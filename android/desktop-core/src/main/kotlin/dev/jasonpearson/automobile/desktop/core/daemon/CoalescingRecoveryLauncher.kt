package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Coalesces daemon-recovery triggers so at most one recovery pass runs at a time.
 *
 * The workspace health sheet's "Start daemon" button (#6035) can be clicked repeatedly — before the
 * pass reports its first phase into [DaemonBootstrap.state], or while [Dispatchers.IO] is saturated
 * — and [DesktopDaemonLifecycle] serializes queued passes rather than coalescing them, so each
 * extra launch would repeat the full daemon-startup budget. [launch] flips [inFlight] true
 * **synchronously on the caller thread** before dispatching and clears it in a `finally` when the
 * pass completes (so a no-op/inactive [recover] releases it too); a call made while a pass is
 * already in flight is dropped. [inFlight] backs the button's disabled state.
 *
 * The [recover] action and [context] are injected so the coalescing guard is exercised directly by
 * a unit test (a fake [recover] + a test dispatcher), rather than re-implemented in the caller.
 */
class CoalescingRecoveryLauncher(
  private val scope: CoroutineScope,
  private val recover: suspend () -> Unit,
  private val context: CoroutineContext = Dispatchers.IO,
) {
  private val _inFlight = MutableStateFlow(false)

  /** Whether a recovery pass launched here is currently running. */
  val inFlight: StateFlow<Boolean> = _inFlight.asStateFlow()

  /**
   * Starts a recovery pass unless one is already in flight. The in-flight claim is made
   * synchronously before dispatch, so two rapid calls on the same (UI) thread coalesce into one
   * pass.
   */
  fun launch() {
    if (_inFlight.value) return
    _inFlight.value = true
    scope.launch(context) {
      try {
        recover()
      } finally {
        _inFlight.value = false
      }
    }
  }
}
