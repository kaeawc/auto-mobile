package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.TestFailureException
import dev.jasonpearson.automobile.sdk.persistence.NoOpEventPersistence
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventBufferPersistenceTest : SdkEventBufferFixture() {
  /**
   * When delivery fails AND the best-effort persistence.persist() also throws, neither must escape
   * flush() — it runs inside scheduleAtFixedRate and an uncaught exception would cancel all future
   * periodic flushes (#3605).
   */
  @Test
  fun `throwing persistence on a failed delivery does not propagate`() {
    var deliveries = 0
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1_000,
        flushIntervalMs = 60_000,
        onFlush = {
          deliveries++
          if (deliveries == 1) throw TestFailureException("delivery failed")
        },
        persistence = ThrowingPersistence(),
      )

    buffer.add(makeEvent(1))
    buffer.flush() // delivery throws -> best-effort persist throws -> both contained

    // The buffer still works afterward (the loop was not broken).
    buffer.add(makeEvent(2))
    buffer.flush()
    assertEquals(2, deliveries)
  }

  /**
   * A successful delivery must NOT persist — avoids a write-then-immediate-delete churn (#3710).
   */
  @Test
  fun `successful delivery does not persist`() {
    val persistence = CountingPersistence()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1_000,
        flushIntervalMs = 60_000,
        onFlush = {}, // succeeds
        persistence = persistence,
      )

    buffer.add(makeEvent(1))
    buffer.flush()

    assertEquals(0, persistence.persistCount.get())
  }

  /** A failed delivery persists the batch for next-launch replay (#3710). */
  @Test
  fun `failed delivery persists for retry`() {
    val persistence = CountingPersistence()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1_000,
        flushIntervalMs = 60_000,
        onFlush = { throw TestFailureException("delivery failed") },
        persistence = persistence,
        executor = executor,
      )

    try {
      buffer.add(makeEvent(1))
      buffer.flush()
      drainExecutor(executor)
      assertEquals(1, persistence.persistCount.get())
      assertNotEquals(Thread.currentThread(), persistence.persistThread.get())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `undelivered batch persists on buffer executor without a drop`() {
    val executor = Executors.newSingleThreadScheduledExecutor { Thread(it, "persist-test") }
    val recorded = CopyOnWriteArrayList<List<SdkEvent>>()
    val threads = CopyOnWriteArrayList<String>()
    val counter = DefaultDropCounter()
    val persistence =
      object : NoOpEventPersistence() {
        override fun persist(events: List<SdkEvent>, deliveryId: String?): String {
          recorded.add(events)
          threads.add(Thread.currentThread().name)
          return "id"
        }

        override fun loadPending(): List<PendingEventBatch> = emptyList()
      }
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = persistence,
        executor = executor,
        dropCounter = counter,
      )
    val events = listOf(makeEvent(1), makeEvent(2))
    try {
      buffer.persistUndelivered(events)
      drainExecutor(executor)
      assertEquals(listOf(events), recorded.toList())
      assertEquals(listOf("persist-test"), threads.toList())
      assertTrue(counter.snapshot().isEmpty())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `null persistence result counts terminal delivery drops`() {
    val executor = Executors.newSingleThreadScheduledExecutor()
    val counter = DefaultDropCounter()
    val persistence =
      object : NoOpEventPersistence() {
        override fun persist(events: List<SdkEvent>, deliveryId: String?): String? = null

        override fun loadPending(): List<PendingEventBatch> = emptyList()
      }
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = persistence,
        executor = executor,
        dropCounter = counter,
      )
    try {
      buffer.persistUndelivered(listOf(makeEvent(1), makeEvent(2)))
      drainExecutor(executor)
      assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `throwing persistence on executor is contained and counts terminal drops`() {
    val executor = Executors.newSingleThreadScheduledExecutor()
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = ThrowingPersistence(),
        executor = executor,
        dropCounter = counter,
      )
    try {
      buffer.persistUndelivered(listOf(makeEvent(1), makeEvent(2)))
      drainExecutor(executor)
      assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
    } finally {
      buffer.shutdown()
    }
  }
}
