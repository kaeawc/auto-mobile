package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

class DropCounterTest {

  // -- DefaultDropCounter unit tests --

  @Test
  fun `increment increases count`() {
    val counter = DefaultDropCounter()
    counter.increment(DropReason.DISABLED)
    counter.increment(DropReason.DISABLED)
    counter.increment(DropReason.SHUTDOWN)

    val snap = counter.snapshot()
    assertEquals(2L, snap[DropReason.DISABLED])
    assertEquals(1L, snap[DropReason.SHUTDOWN])
  }

  @Test
  fun `snapshot returns a copy`() {
    val counter = DefaultDropCounter()
    counter.increment(DropReason.FLUSH_ERROR)

    val snap = counter.snapshot()
    counter.increment(DropReason.FLUSH_ERROR)

    assertEquals(1L, snap[DropReason.FLUSH_ERROR], "Snapshot should not reflect later increments")
    assertEquals(2L, counter.snapshot()[DropReason.FLUSH_ERROR])
  }

  @Test
  fun `reset clears all counters`() {
    val counter = DefaultDropCounter()
    counter.increment(DropReason.DISABLED)
    counter.increment(DropReason.SHUTDOWN)
    counter.reset()

    assertTrue(counter.snapshot().isEmpty(), "Snapshot should be empty after reset")
  }

  @Test
  fun `concurrent increments produce correct total`() {
    val counter = DefaultDropCounter()
    val latch = CountDownLatch(1)
    val threads =
      (1..10).map {
        Thread {
          latch.await()
          repeat(1_000) { counter.increment(DropReason.DISABLED) }
        }
      }
    threads.forEach { it.start() }
    latch.countDown()
    threads.forEach { it.join(5_000) }

    assertEquals(10_000L, counter.snapshot()[DropReason.DISABLED])
  }

  // -- SdkEventBuffer integration tests --

  private fun makeEvent(i: Int): SdkEvent =
    SdkLifecycleEvent(
      timestamp = i.toLong(),
      kind = "event-$i",
    )

  @Test
  fun `buffer counts drops when disabled`() {
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = {},
        executor = Executors.newSingleThreadScheduledExecutor(),
        dropCounter = counter,
      )

    buffer.isEnabled = false
    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))

    assertEquals(2L, counter.snapshot()[DropReason.DISABLED])
  }

  @Test
  fun `buffer counts drops when shutdown`() {
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = {},
        executor = Executors.newSingleThreadScheduledExecutor(),
        dropCounter = counter,
      )

    buffer.shutdown()
    buffer.add(makeEvent(1))

    assertEquals(1L, counter.snapshot()[DropReason.SHUTDOWN])
  }

  @Test
  fun `buffer counts drops on flush error`() {
    val counter = DefaultDropCounter()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 2,
        flushIntervalMs = 60_000,
        onFlush = { throw RuntimeException("boom") },
        executor = executor,
        dropCounter = counter,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2)) // triggers capacity flush which throws
    executor.submit {}.get(1, TimeUnit.SECONDS) // wait for async capacity flush

    assertEquals(
      2L,
      counter.snapshot()[DropReason.FLUSH_ERROR],
      "Each dropped event should be counted",
    )
  }
}
