package dev.jasonpearson.automobile.desktop.core.connection

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class DaemonConnectionMonitorTest {

  private fun monitor(
    probe: suspend () -> Unit,
    pollIntervalMs: Long = 5_000,
    probeTimeoutMs: Long = 10_000,
    onProbeFailure: (Throwable) -> Unit = {},
  ) =
    DaemonConnectionMonitor(
      probe = probe,
      pollInterval = pollIntervalMs.milliseconds,
      probeTimeout = probeTimeoutMs.milliseconds,
      onProbeFailure = onProbeFailure,
    )

  @Test
  fun `first emission is Connecting before any probe runs`() = runTest {
    var probes = 0
    val first = monitor(probe = { probes++ }).connectionStates().take(1).toList().single()

    assertEquals(ConnectionState.Connecting, first)
    assertEquals(0, probes, "Connecting must be emitted before the first probe")
  }

  @Test
  fun `successful probe yields Connected`() = runTest {
    val states = monitor(probe = {}).connectionStates().take(2).toList()

    assertEquals(ConnectionState.Connecting, states[0])
    assertTrue(states[1] is ConnectionState.Connected, "expected Connected, got ${states[1]}")
  }

  @Test
  fun `throwing probe yields Disconnected carrying the failure reason`() = runTest {
    val states =
      monitor(probe = { throw IllegalStateException("socket refused") })
        .connectionStates()
        .take(2)
        .toList()

    val disconnected = states[1] as ConnectionState.Disconnected
    assertEquals("socket refused", disconnected.reason)
  }

  @Test
  fun `monitor re-probes on the poll interval cadence`() = runTest {
    var probes = 0
    val job = backgroundScope.launch {
      monitor(probe = { probes++ }, pollIntervalMs = 5_000).connectionStates().collect {}
    }

    runCurrent()
    assertEquals(1, probes, "one probe should run immediately")

    advanceTimeBy(5_001)
    assertEquals(2, probes)

    advanceTimeBy(5_000)
    assertEquals(3, probes)

    job.cancel()
  }

  @Test
  fun `probe that never completes times out to Disconnected and the loop keeps polling`() =
    runTest {
      // A probe that suspends forever must be bounded by probeTimeout and surface Disconnected —
      // and, crucially, the loop must survive the TimeoutCancellationException (a
      // CancellationException subtype) rather than being torn down by it (#4858).
      val states =
        monitor(probe = { awaitCancellation() }, probeTimeoutMs = 10_000)
          .connectionStates()
          .take(3)
          .toList()

      assertEquals(ConnectionState.Connecting, states[0])
      val firstTimeout = states[1] as ConnectionState.Disconnected
      assertTrue(
        firstTimeout.reason?.contains("timed out") == true,
        "expected a timeout reason, got ${firstTimeout.reason}",
      )
      // A third emission proves the poll loop continued after the timeout.
      assertTrue(states[2] is ConnectionState.Disconnected)
    }

  @Test
  fun `onProbeFailure fires for a thrown probe but not for a success`() = runTest {
    val failures = mutableListOf<Throwable>()
    var throwNext = false
    monitor(
        probe = {
          if (throwNext) throw IllegalStateException("socket refused") else throwNext = true
        },
        onProbeFailure = { failures.add(it) },
      )
      .connectionStates()
      .take(3)
      .toList()

    // First probe succeeds (no failure recorded), second throws (recorded once). The instance may
    // be a stacktrace-recovery copy from crossing the withTimeout coroutine boundary, so compare on
    // type + message rather than identity.
    val failure = failures.single()
    assertTrue(failure is IllegalStateException, "expected IllegalStateException, got $failure")
    assertEquals("socket refused", failure.message)
  }

  @Test
  fun `cancelling collection stops the poll loop without leaking a cancellation`() = runTest {
    var probes = 0
    var leaked: Throwable? = null
    val job = backgroundScope.launch {
      try {
        monitor(probe = { probes++ }, pollIntervalMs = 5_000).connectionStates().collect {}
      } catch (_: CancellationException) {
        // expected on cancel; cooperative
      } catch (t: Throwable) {
        leaked = t
      }
    }

    runCurrent()
    advanceTimeBy(5_001)
    val probesAtCancel = probes
    job.cancel()
    advanceTimeBy(50_000)

    assertEquals(probesAtCancel, probes, "no further probes after cancellation")
    assertEquals(null, leaked, "cancellation must not surface as a non-cancellation failure")
  }
}
