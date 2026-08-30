package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Virtual-time coverage of the shared reconnect lifecycle: retry-with-backoff on a failed mount,
 * reconnect on a mid-session drop/EOF, stop-on-dispose, and skip-while-daemon-down. Time is the
 * injected [GatedBackoff] seam (each attempt awaits a deferred the test releases), so reconnect
 * attempts step deterministically with zero wall time and nothing touches a real socket.
 */
@OptIn(ExperimentalTestApi::class)
class ReconnectingObservationStreamTest {

  /** A backoff seam that records each attempt and blocks until the test releases that attempt. */
  private class GatedBackoff {
    val attempts = CopyOnWriteArrayList<Int>()
    private val gates = ConcurrentHashMap<Int, CompletableDeferred<Unit>>()

    private fun gate(attempt: Int) = gates.getOrPut(attempt) { CompletableDeferred() }

    val seam: suspend (Int) -> Unit = { attempt ->
      attempts += attempt
      gate(attempt).await()
    }

    fun release(attempt: Int) {
      gate(attempt).complete(Unit)
    }
  }

  @Test
  fun `retries connect with incrementing backoff when the socket is unavailable at mount`() =
    runComposeUiTest {
      val fake = FakeObservationStream(failConnect = true)
      val backoff = GatedBackoff()
      setContent {
        rememberReconnectingObservationStream(
          deviceId = "dev-1",
          streamFactory = { fake },
          backoffDelay = backoff.seam,
          socketAvailable = { true },
        )
      }
      waitForIdle()
      // Mount connected once, failed, and the loop is now backing off before the first retry.
      assertEquals(1, fake.connectCallCount)
      assertTrue("expected the loop to enter backoff attempt 1", backoff.attempts.contains(1))

      // Releasing the first backoff issues exactly one reconnect, then backs off again (attempt 2).
      runOnIdle { backoff.release(1) }
      waitForIdle()
      assertEquals(2, fake.connectCallCount)
      assertEquals("dev-1", fake.lastConnectedDeviceId)
      assertTrue("expected an incrementing second backoff attempt", backoff.attempts.contains(2))

      runOnIdle { backoff.release(2) }
      waitForIdle()
      assertEquals(3, fake.connectCallCount)
    }

  @Test
  fun `reconnects the same stream after a mid-session drop`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val backoff = GatedBackoff()
    setContent {
      rememberReconnectingObservationStream(
        deviceId = "dev-1",
        deviceSessionUuid = "epoch-a",
        streamFactory = { fake },
        backoffDelay = backoff.seam,
        socketAvailable = { true },
      )
    }
    waitForIdle()
    // Healthy mount: connected once, no backoff yet (loop is waiting for a drop).
    assertEquals(1, fake.connectCallCount)
    assertTrue("a healthy stream must not back off", backoff.attempts.isEmpty())

    // A daemon restart / EOF surfaces as a Disconnected connection state.
    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
    waitForIdle()
    assertTrue("expected the drop to trigger a backoff", backoff.attempts.contains(1))

    runOnIdle { backoff.release(1) }
    waitForIdle()
    // Reconnected on the same instance.
    assertEquals(2, fake.connectCallCount)
    assertEquals("epoch-a", fake.lastConnectedDeviceSessionUuid)
  }

  @Test
  fun `stops reconnecting once the surface leaves composition`() = runComposeUiTest {
    val fake = FakeObservationStream(failConnect = true)
    val backoff = GatedBackoff()
    val visible = mutableStateOf(true)
    setContent {
      if (visible.value) {
        rememberReconnectingObservationStream(
          deviceId = "dev-1",
          streamFactory = { fake },
          backoffDelay = backoff.seam,
          socketAvailable = { true },
        )
      }
    }
    waitForIdle()
    assertEquals(1, fake.connectCallCount)
    assertTrue(backoff.attempts.contains(1))

    // Leave composition while suspended in backoff, then release the gate.
    runOnIdle { visible.value = false }
    waitForIdle()
    runOnIdle { backoff.release(1) }
    waitForIdle()

    // No reconnect fired after dispose, and the stream was disposed.
    assertEquals(1, fake.connectCallCount)
    assertTrue("expected the stream to be disposed on removal", fake.disconnectCallCount >= 1)
  }

  @Test
  fun `skips connect while the daemon socket is absent, then recovers when it returns`() =
    runComposeUiTest {
      val fake = FakeObservationStream(failConnect = true)
      val backoff = GatedBackoff()
      val socketUp = mutableStateOf(false)
      setContent {
        rememberReconnectingObservationStream(
          deviceId = "dev-1",
          streamFactory = { fake },
          backoffDelay = backoff.seam,
          socketAvailable = { socketUp.value },
        )
      }
      waitForIdle()
      assertEquals(1, fake.connectCallCount)

      // Socket absent: releasing backoffs keeps looping but issues no reconnect.
      runOnIdle { backoff.release(1) }
      waitForIdle()
      runOnIdle { backoff.release(2) }
      waitForIdle()
      assertEquals("must not connect while the socket is absent", 1, fake.connectCallCount)

      // Once the daemon returns, the next backoff cycle reconnects.
      runOnIdle { socketUp.value = true }
      runOnIdle { backoff.release(3) }
      waitForIdle()
      assertTrue("expected reconnect once the socket returned", fake.connectCallCount >= 2)
    }

  @Test
  fun `resets the backoff after a healthy reconnect`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val backoff = GatedBackoff()
    setContent {
      rememberReconnectingObservationStream(
        deviceId = "dev-1",
        streamFactory = { fake },
        backoffDelay = backoff.seam,
        socketAvailable = { true },
      )
    }
    waitForIdle()
    assertEquals(1, fake.connectCallCount)

    // First drop → backoff attempt 1 → reconnect succeeds.
    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("drop 1")) }
    waitForIdle()
    runOnIdle { backoff.release(1) }
    waitForIdle()
    assertEquals(2, fake.connectCallCount)
    assertEquals(listOf(1), backoff.attempts.toList())

    // Second drop must restart the backoff at attempt 1, not continue to 2, because the reconnect
    // in between was healthy (Connected). A non-resetting counter would record attempt 2 here.
    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("drop 2")) }
    waitForIdle()
    assertEquals(
      "backoff must reset to attempt 1 after a healthy reconnect",
      listOf(1, 1),
      backoff.attempts.toList(),
    )
    assertEquals(3, fake.connectCallCount)
  }

  @Test
  fun `backoff grows exponentially and caps`() {
    assertEquals(RECONNECT_INITIAL_DELAY_MS, reconnectBackoffMs(1))
    assertEquals(RECONNECT_INITIAL_DELAY_MS * 2, reconnectBackoffMs(2))
    assertEquals(RECONNECT_INITIAL_DELAY_MS * 4, reconnectBackoffMs(3))
    // Monotonic non-decreasing and capped.
    var prev = 0L
    for (attempt in 1..40) {
      val d = reconnectBackoffMs(attempt)
      assertTrue("attempt $attempt not monotonic ($prev -> $d)", d >= prev)
      assertTrue("attempt $attempt exceeds cap", d <= RECONNECT_MAX_DELAY_MS)
      prev = d
    }
    assertEquals(RECONNECT_MAX_DELAY_MS, reconnectBackoffMs(40))
  }
}
