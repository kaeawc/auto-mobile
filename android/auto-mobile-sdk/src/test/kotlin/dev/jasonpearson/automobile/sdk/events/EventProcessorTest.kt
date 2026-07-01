package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import org.junit.Test

class EventProcessorTest {

  private fun makeEvent(name: String = "test"): SdkEvent =
      SdkLifecycleEvent(
          timestamp = 1L,
          kind = name,
      )

  private fun drainExecutor(executor: java.util.concurrent.ScheduledExecutorService) {
    executor.submit {}.get(1, TimeUnit.SECONDS)
  }

  @Test
  fun `processor that returns event allows buffering`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
        SdkEventBuffer(
            maxBufferSize = 100,
            flushIntervalMs = 60_000,
            onFlush = { flushed.add(it) },
            executor = Executors.newSingleThreadScheduledExecutor(),
            processors = listOf(EventProcessor { it }),
        )

    buffer.add(makeEvent())
    buffer.flush()

    assertEquals(1, flushed.size)
    assertEquals(1, flushed[0].size)
  }

  @Test
  fun `processor that returns null drops event`() {
    val counter = DefaultDropCounter()
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
        SdkEventBuffer(
            maxBufferSize = 100,
            flushIntervalMs = 60_000,
            onFlush = { flushed.add(it) },
            executor = Executors.newSingleThreadScheduledExecutor(),
            dropCounter = counter,
            processors = listOf(EventProcessor { null }),
        )

    buffer.add(makeEvent())
    buffer.flush()

    assertEquals(0, flushed.size, "Dropped event should not be flushed")
    assertEquals(1L, counter.snapshot()[DropReason.FILTERED])
  }

  @Test
  fun `processors run in order and can modify event`() {
    val flushed = CopyOnWriteArrayList<List<SdkEvent>>()
    val buffer =
        SdkEventBuffer(
            maxBufferSize = 100,
            flushIntervalMs = 60_000,
            onFlush = { flushed.add(it) },
            executor = Executors.newSingleThreadScheduledExecutor(),
            processors =
                listOf(
                    EventProcessor { event ->
                      // First processor: modify the event
                      SdkLifecycleEvent(timestamp = event.timestamp, kind = "modified")
                    },
                    EventProcessor { event ->
                      // Second processor: sees modified event
                      val lifecycle = event as SdkLifecycleEvent
                      if (lifecycle.kind == "modified") event else null
                    },
                ),
        )

    buffer.add(makeEvent("original"))
    buffer.flush()

    assertEquals(1, flushed.size)
    val result = flushed[0][0] as SdkLifecycleEvent
    assertEquals("modified", result.kind)
  }

  @Test
  fun `second processor returning null drops event`() {
    val counter = DefaultDropCounter()
    val buffer =
        SdkEventBuffer(
            maxBufferSize = 100,
            flushIntervalMs = 60_000,
            onFlush = {},
            executor = Executors.newSingleThreadScheduledExecutor(),
            dropCounter = counter,
            processors =
                listOf(
                    EventProcessor { it }, // pass-through
                    EventProcessor { null }, // drop
                ),
        )

    buffer.add(makeEvent())
    assertEquals(1L, counter.snapshot()[DropReason.FILTERED])
  }

  @Test
  fun `maxPendingEvents evicts oldest on overflow`() {
    val counter = DefaultDropCounter()
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
        SdkEventBuffer(
            maxBufferSize = 100, // high so capacity flush doesn't trigger
            flushIntervalMs = 60_000,
            onFlush = { flushed.add(it) },
            executor = Executors.newSingleThreadScheduledExecutor(),
            dropCounter = counter,
            maxPendingEvents = 3,
        )

    buffer.add(makeEvent("a"))
    buffer.add(makeEvent("b"))
    buffer.add(makeEvent("c"))
    // Buffer is now full at maxPendingEvents=3
    buffer.add(makeEvent("d")) // should evict "a"

    assertEquals(1L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])

    buffer.flush()
    assertEquals(1, flushed.size)
    val names = flushed[0].map { (it as SdkLifecycleEvent).kind }
    assertEquals(listOf("b", "c", "d"), names, "Oldest event should have been evicted")
  }

  @Test
  fun `maxPendingEvents counts multiple overflows`() {
    val counter = DefaultDropCounter()
    val buffer =
        SdkEventBuffer(
            maxBufferSize = 100,
            flushIntervalMs = 60_000,
            onFlush = {},
            executor = Executors.newSingleThreadScheduledExecutor(),
            dropCounter = counter,
            maxPendingEvents = 2,
        )

    // Add 5 events with cap of 2
    repeat(5) { buffer.add(makeEvent("e$it")) }

    assertEquals(3L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
  }
}
