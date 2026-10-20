package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventBufferOverflowTest : SdkEventBufferFixture() {
  @Test
  fun `queued batches participate in pending event cap`() {
    val executor = Executors.newSingleThreadScheduledExecutor()
    val deliveryStarted = CountDownLatch(1)
    val releaseDelivery = CountDownLatch(1)
    val deliveries = CopyOnWriteArrayList<List<SdkEvent>>()
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = { events ->
          deliveries.add(ArrayList(events))
          if (events.first().timestamp == 1L) {
            deliveryStarted.countDown()
            releaseDelivery.await()
          }
        },
        executor = executor,
        dropCounter = counter,
        maxPendingEvents = 3,
      )

    try {
      buffer.add(makeEvent(1))
      assertTrue(deliveryStarted.await(1, TimeUnit.SECONDS), "First delivery should block")

      buffer.add(makeEvent(2))
      buffer.add(makeEvent(3))
      buffer.add(makeEvent(4))
      buffer.add(makeEvent(5))
      releaseDelivery.countDown()
      buffer.shutdown()

      assertTrue(
        executor.awaitTermination(1, TimeUnit.SECONDS),
        "Shutdown should drain queued batches",
      )
      assertEquals(listOf(1L, 3L, 4L, 5L), deliveries.flatten().map { it.timestamp })
      assertEquals(1L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
    } finally {
      releaseDelivery.countDown()
      executor.shutdownNow()
    }
  }

  @Test
  fun `IGNORE_NEWEST drops incoming event when buffer full`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
        dropCounter = counter,
        maxPendingEvents = 3,
        backPressureStrategy = BackPressureStrategy.IGNORE_NEWEST,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.add(makeEvent(3))
    // Buffer is now full — next event should be dropped
    buffer.add(makeEvent(4))
    buffer.flush()

    assertEquals(1, flushed.size)
    assertEquals(3, flushed[0].size, "Only the first 3 events should be in the buffer")
    val timestamps = flushed[0].map { it.timestamp }
    assertEquals(listOf(1L, 2L, 3L), timestamps, "Original events should be preserved")

    val snapshot = counter.snapshot()
    assertEquals(1L, snapshot[DropReason.BUFFER_OVERFLOW], "Dropped event should be counted")
  }

  @Test
  fun `IGNORE_NEWEST allows events after flush frees space`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
        maxPendingEvents = 2,
        backPressureStrategy = BackPressureStrategy.IGNORE_NEWEST,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    // Buffer full — this should be dropped
    buffer.add(makeEvent(3))
    // Flush to free space
    buffer.flush()
    // Now buffer has space again
    buffer.add(makeEvent(4))
    buffer.flush()

    assertEquals(2, flushed.size)
    assertEquals(listOf(1L, 2L), flushed[0].map { it.timestamp })
    assertEquals(listOf(4L), flushed[1].map { it.timestamp })
  }

  @Test
  fun `DROP_OLDEST evicts oldest event when buffer full`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
        dropCounter = counter,
        maxPendingEvents = 3,
        backPressureStrategy = BackPressureStrategy.DROP_OLDEST,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.add(makeEvent(3))
    buffer.add(makeEvent(4))
    buffer.flush()

    assertEquals(1, flushed.size)
    assertEquals(3, flushed[0].size, "Buffer should contain maxPendingEvents events")
    val timestamps = flushed[0].map { it.timestamp }
    assertEquals(listOf(2L, 3L, 4L), timestamps, "Oldest event should have been evicted")

    val snapshot = counter.snapshot()
    assertEquals(1L, snapshot[DropReason.BUFFER_OVERFLOW])
  }
}
