package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.TestFailureException
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import org.junit.Test

internal class SdkEventBufferErrorTest : SdkEventBufferFixture() {
  @Test
  fun `flush error counts each dropped event`() {
    val counter = DefaultDropCounter()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 5,
        flushIntervalMs = 60_000,
        onFlush = { throw TestFailureException("delivery failed") },
        executor = executor,
        dropCounter = counter,
      )

    // Add 5 events to trigger capacity flush
    repeat(5) { buffer.add(makeEvent(it)) }
    drainExecutor(executor) // capacity flush is async

    val snapshot = counter.snapshot()
    assertEquals(
      5L,
      snapshot[DropReason.FLUSH_ERROR],
      "Each dropped event should be counted individually",
    )
  }

  @Test
  fun `onFlush exceptions are swallowed`() {
    var callCount = 0
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 2,
        flushIntervalMs = 60_000,
        onFlush = {
          callCount++
          if (callCount == 1) throw TestFailureException("test error")
        },
        executor = executor,
      )

    // First flush throws but doesn't crash
    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    drainExecutor(executor) // capacity flush is async

    // Second flush succeeds
    buffer.add(makeEvent(3))
    buffer.add(makeEvent(4))
    drainExecutor(executor) // capacity flush is async

    assertEquals(2, callCount)
  }

  @Test
  fun `throwing processor drops event and counts PROCESSOR_ERROR`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
        dropCounter = counter,
        processors = listOf(EventProcessor { throw TestFailureException("processor failed") }),
      )

    buffer.add(makeEvent(1))
    buffer.flush()

    assertEquals(0, flushed.size, "Event should not be buffered when processor throws")
    val snapshot = counter.snapshot()
    assertEquals(1L, snapshot[DropReason.PROCESSOR_ERROR], "PROCESSOR_ERROR should be counted")
  }

  @Test
  fun `throwing processor does not prevent subsequent events`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    var shouldThrow = true
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
        processors =
          listOf(
            EventProcessor { event ->
              if (shouldThrow) throw TestFailureException("fail")
              event
            },
          ),
      )

    buffer.add(makeEvent(1)) // dropped due to processor error
    shouldThrow = false
    buffer.add(makeEvent(2)) // should succeed
    buffer.flush()

    assertEquals(1, flushed.size, "Second event should be buffered after first processor failure")
    assertEquals(1, flushed[0].size)
  }
}
