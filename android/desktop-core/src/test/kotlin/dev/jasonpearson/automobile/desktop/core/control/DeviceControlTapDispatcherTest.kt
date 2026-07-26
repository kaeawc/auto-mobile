package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** Ordering coverage for the serialized control-tap dispatcher (issue #3347). */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceControlTapDispatcherTest {

  private fun command(token: Long) =
    DeviceControlTapCommand(
      point = DevicePoint(x = 0, y = 0, inBounds = true),
      client = null,
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

    (0L until 5L).forEach { dispatcher.enqueue(command(it)) }
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

    repeat(4) { dispatcher.enqueue(command(it.toLong())) }
    advanceUntilIdle()

    assertEquals(1, maxConcurrent, "the consumer must forward taps one at a time")
    scope.cancel()
  }
}
