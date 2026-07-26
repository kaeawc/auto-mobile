package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** Ordering + back-pressure coverage for the serialized control-tap dispatcher (issue #3347). */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceControlTapDispatcherTest {

  private fun command(token: Long = 0L, client: AutoMobileClient? = null) =
    DeviceControlTapCommand(
      point = DevicePoint(x = 0, y = 0, inBounds = true),
      client = client,
      platform = "android",
      deviceId = "emulator-5554",
      token = token,
    )

  @Test
  fun `taps are processed in click order even when earlier taps take longer`() = runTest {
    // Unconfined test dispatcher so the single consumer starts eagerly; virtual delays still
    // advance
    // via the shared scheduler.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val processed = mutableListOf<Long>()
    val dispatcher =
      DeviceControlTapDispatcher(scope) { cmd ->
        // Earlier taps (lower token) take LONGER. Independent per-tap coroutines would finish in
        // reverse order; the single-consumer FIFO queue must keep them in click order.
        delay(50 - cmd.token * 10)
        processed.add(cmd.token)
      }

    (0L until 5L).forEach { dispatcher.enqueue(command(token = it)) }
    advanceUntilIdle()

    assertEquals(listOf(0L, 1L, 2L, 3L, 4L), processed)
    scope.cancel()
  }

  @Test
  fun `each tap completes before the next begins`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    var inFlight = 0
    var maxConcurrent = 0
    val dispatcher =
      DeviceControlTapDispatcher(scope) { _ ->
        inFlight++
        maxConcurrent = maxOf(maxConcurrent, inFlight)
        delay(10)
        inFlight--
      }

    repeat(4) { dispatcher.enqueue(command(token = it.toLong())) }
    advanceUntilIdle()

    assertEquals(1, maxConcurrent, "the consumer must forward taps one at a time")
    scope.cancel()
  }

  @Test
  fun `a full queue rejects the newest tap and closes its client`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val stall = CompletableDeferred<Unit>() // never completes: the consumer stays on the first tap
    val dispatcher = DeviceControlTapDispatcher(scope) { _ -> stall.await() }

    // One tap is in flight (stalled), the bounded buffer holds the rest, the remainder overflow.
    val clients =
      (0..DeviceControlTapDispatcher.TAP_QUEUE_CAPACITY + 2).map { FakeAutoMobileClient() }
    val accepted = clients.map { dispatcher.enqueue(command(client = it)) }

    assertTrue(accepted.any { !it }, "taps past the bounded capacity must be rejected")
    clients.zip(accepted).forEach { (client, ok) ->
      if (!ok) assertTrue("close" in client.calls, "a rejected tap's client must be closed")
    }
    scope.cancel()
  }

  @Test
  fun `reset closes every pending tap's client and none of them forward`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val stall = CompletableDeferred<Unit>()
    val forwarded = mutableListOf<Long>()
    val dispatcher =
      DeviceControlTapDispatcher(scope) { cmd ->
        if (cmd.token == 0L) stall.await() else forwarded.add(cmd.token)
      }

    // Tap 0 is in flight (stalled); taps 1..5 sit pending in the queue.
    val clients = (0L..5L).map { FakeAutoMobileClient() }
    clients.forEachIndexed { index, client ->
      dispatcher.enqueue(command(token = index.toLong(), client = client))
    }

    dispatcher.reset()
    advanceUntilIdle()

    (1..5).forEach {
      assertTrue("close" in clients[it].calls, "pending client $it closed by reset")
    }
    assertFalse(
      "close" in clients[0].calls,
      "the in-flight tap's client is left to its own finally",
    )
    assertEquals(emptyList(), forwarded, "no pending tap forwards after reset")
    scope.cancel()
  }
}
