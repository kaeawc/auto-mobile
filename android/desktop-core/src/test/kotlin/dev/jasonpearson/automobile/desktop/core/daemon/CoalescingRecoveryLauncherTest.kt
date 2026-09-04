package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

// Note: the finally-reset-on-failure path is not unit-tested here because the injected recover in
// production is `daemonBootstrap.ensureReady()`, which reports failures as
// DaemonBootstrapState.Failed
// rather than throwing; a throwing recover in a `launch` child would fail runTest itself.

/**
 * Exercises the PRODUCTION coalescing guard (#6080). The workspace wires `onRecoverDaemon = {
 * recoveryLauncher.launch() }`, so testing [CoalescingRecoveryLauncher.launch] directly proves the
 * rapid-click regression is caught in the shipped seam — not re-implemented in a test callback.
 */
class CoalescingRecoveryLauncherTest {

  @Test
  fun `a second launch while a pass is in flight does not start a second recover`() = runTest {
    var recoverCount = 0
    // recover() stays in flight until the gate completes, modeling a slow ensureReady() pass.
    val gate = CompletableDeferred<Unit>()
    val launcher =
      CoalescingRecoveryLauncher(
        scope = this,
        // EmptyCoroutineContext so the launched pass runs on the test dispatcher (deterministic).
        context = EmptyCoroutineContext,
        recover = {
          recoverCount++
          gate.await()
        },
      )

    launcher.launch()
    runCurrent() // let the first pass start and suspend on the gate
    assertTrue(launcher.inFlight.value)
    assertEquals(1, recoverCount)

    // Two more clicks while the first pass is still running — both must be dropped.
    launcher.launch()
    launcher.launch()
    runCurrent()
    assertEquals(1, recoverCount)

    // Once the pass completes the flag clears and a fresh launch runs again.
    gate.complete(Unit)
    runCurrent()
    assertFalse(launcher.inFlight.value)

    val gate2 = CompletableDeferred<Unit>()
    val launcher2 =
      CoalescingRecoveryLauncher(
        scope = this,
        context = EmptyCoroutineContext,
        recover = {
          recoverCount++
          gate2.await()
        },
      )
    launcher2.launch()
    runCurrent()
    assertEquals(2, recoverCount)
    gate2.complete(Unit)
    runCurrent()
  }
}
