package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
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
class DeviceControlInputDispatcherTest {

  private fun command(
    token: Long = 0L,
    client: AutoMobileClient? = null,
    snapshot: DeviceFrameSnapshot = testSnapshot(),
  ) =
    DeviceControlInputCommand.Tap(
      point = DevicePoint(x = 0, y = 0, inBounds = true),
      client = client,
      platform = "android",
      snapshot = snapshot,
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
      DeviceControlInputDispatcher(scope) { cmd ->
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
      DeviceControlInputDispatcher(scope) { _ ->
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
    val dispatcher = DeviceControlInputDispatcher(scope) { _ -> stall.await() }

    // One tap is in flight (stalled), the bounded buffer holds the rest, the remainder overflow.
    val clients =
      (0..DeviceControlInputDispatcher.INPUT_QUEUE_CAPACITY + 2).map { FakeAutoMobileClient() }
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
      DeviceControlInputDispatcher(scope) { cmd ->
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

  @Test
  fun `discarding a stale frame context preserves newer pending commands`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val stall = CompletableDeferred<Unit>()
    val forwarded = mutableListOf<Long>()
    val dispatcher =
      DeviceControlInputDispatcher(scope) { cmd ->
        if (cmd.token == 0L) stall.await() else forwarded += cmd.token
      }
    val staleSnapshot = testSnapshot(sequence = 7L)
    val freshSnapshot = testSnapshot(sequence = 8L)
    val staleClient = FakeAutoMobileClient()
    val freshClient = FakeAutoMobileClient()

    dispatcher.enqueue(command(token = 0L))
    dispatcher.enqueue(command(token = 1L, client = staleClient, snapshot = staleSnapshot))
    dispatcher.enqueue(command(token = 2L, client = freshClient, snapshot = freshSnapshot))

    assertEquals(1L, dispatcher.discardFrameContext(staleSnapshot.frameContext))
    stall.complete(Unit)
    advanceUntilIdle()

    assertTrue("close" in staleClient.calls, "stale pending command must be closed")
    assertFalse("close" in freshClient.calls, "newer pending command must stay queued")
    assertEquals(listOf(2L), forwarded)
    scope.cancel()
  }

  @Test
  fun `every input action shares one queue and drains in gesture order`() = runTest {
    // Issues #3350 and #3351: no action may get its own queue, or a tap-then-swipe-then-type
    // sequence could execute reversed — the exact race the single-consumer FIFO exists to remove.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val processed = mutableListOf<String>()
    val dispatcher =
      DeviceControlInputDispatcher(scope) { cmd ->
        // Earlier commands take LONGER, so anything but one FIFO consumer reorders them.
        delay(50 - cmd.token * 10)
        processed.add(
          when (cmd) {
            is DeviceControlInputCommand.Tap -> "tap${cmd.token}"
            is DeviceControlInputCommand.Swipe -> "swipe${cmd.token}"
            is DeviceControlInputCommand.PressButton -> "button${cmd.token}"
            is DeviceControlInputCommand.TypeText -> "text${cmd.token}"
            is DeviceControlInputCommand.SendKey -> "key${cmd.token}"
            is DeviceControlInputCommand.StreamGesture -> "stream${cmd.token}"
          }
        )
      }

    dispatcher.enqueue(command(token = 0L))
    dispatcher.enqueue(
      DeviceControlInputCommand.Swipe(
        start = DevicePoint(x = 10, y = 20, inBounds = true),
        end = DevicePoint(x = 10, y = 900, inBounds = true),
        durationMs = 300,
        client = null,
        platform = "android",
        snapshot = testSnapshot(),
        token = 1L,
      )
    )
    dispatcher.enqueue(
      DeviceControlInputCommand.TypeText(
        text = "a",
        client = null,
        platform = "android",
        snapshot = testSnapshot(),
        token = 2L,
      )
    )
    dispatcher.enqueue(
      DeviceControlInputCommand.SendKey(
        key = "enter",
        client = null,
        platform = "android",
        snapshot = testSnapshot(),
        token = 3L,
      )
    )
    dispatcher.enqueue(
      DeviceControlInputCommand.PressButton(
        button = "back",
        client = null,
        platform = "android",
        snapshot = testSnapshot(),
        token = 4L,
      )
    )
    advanceUntilIdle()

    assertEquals(listOf("tap0", "swipe1", "text2", "key3", "button4"), processed)
    scope.cancel()
  }
}
