package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

class SdkEventBufferTest {

  private fun makeEvent(i: Int): SdkEvent =
    SdkLifecycleEvent(
      timestamp = i.toLong(),
      kind = "event-$i",
    )

  /** Wait for any pending tasks on the executor to complete. */
  private fun drainExecutor(executor: ScheduledExecutorService) {
    executor.submit {}.get(1, TimeUnit.SECONDS)
  }

  private class TimerGatedExecutor : ScheduledThreadPoolExecutor(1) {
    private val timerStarted = CountDownLatch(1)
    private val allowTimer = CountDownLatch(1)

    override fun scheduleAtFixedRate(
      command: Runnable,
      initialDelay: Long,
      period: Long,
      unit: TimeUnit,
    ) =
      super.scheduleAtFixedRate(
        {
          timerStarted.countDown()
          allowTimer.await()
          command.run()
        },
        initialDelay,
        period,
        unit,
      )

    fun awaitTimerStart(): Boolean = timerStarted.await(1, TimeUnit.SECONDS)

    fun releaseTimer() {
      allowTimer.countDown()
    }
  }

  @Test
  fun `flush on capacity`() {
    val flushed = CopyOnWriteArrayList<List<SdkEvent>>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 3,
        flushIntervalMs = 60_000, // Very long so timer won't fire
        onFlush = { flushed.add(it) },
        executor = executor,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    assertEquals(0, flushed.size, "Should not flush before capacity")

    buffer.add(makeEvent(3))
    drainExecutor(executor) // capacity flush is async
    assertEquals(1, flushed.size, "Should flush at capacity")
    assertEquals(3, flushed[0].size)
  }

  @Test
  fun `capacity delivery runs on executor without blocking caller`() {
    val executorThreadName = "SdkEventBuffer-test-executor"
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, executorThreadName)
    }
    val deliveryStarted = CountDownLatch(1)
    val releaseDelivery = CountDownLatch(1)
    val addReturned = CountDownLatch(1)
    val flushThread = AtomicReference<String>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = {
          flushThread.set(Thread.currentThread().name)
          deliveryStarted.countDown()
          releaseDelivery.await()
        },
        executor = executor,
      )
    val caller =
      Thread(
        {
          buffer.add(makeEvent(1))
          addReturned.countDown()
        },
        "SDK host caller",
      )

    try {
      caller.start()
      assertTrue(deliveryStarted.await(1, TimeUnit.SECONDS), "Delivery should begin")
      assertTrue(
        addReturned.await(100, TimeUnit.MILLISECONDS),
        "add() should not wait for delivery",
      )
      assertEquals(executorThreadName, flushThread.get())
    } finally {
      releaseDelivery.countDown()
      caller.join(1_000)
      executor.shutdownNow()
    }
  }

  @Test
  fun `capacity and timer delivery retain event order and ownership`() {
    val executor = TimerGatedExecutor()
    val deliveries = CopyOnWriteArrayList<List<SdkEvent>>()
    val delivered = CountDownLatch(2)
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 2,
        flushIntervalMs = 1,
        onFlush = {
          deliveries.add(ArrayList(it))
          delivered.countDown()
        },
        executor = executor,
      )

    try {
      buffer.start()
      assertTrue(executor.awaitTimerStart(), "Timer task should be pending")

      buffer.add(makeEvent(1))
      buffer.add(makeEvent(2))
      buffer.add(makeEvent(3))
      executor.releaseTimer()

      assertTrue(delivered.await(1, TimeUnit.SECONDS), "Both batches should be delivered")
      assertEquals(listOf(1L, 2L, 3L), deliveries.flatten().map { it.timestamp })
    } finally {
      executor.releaseTimer()
      buffer.shutdown()
      executor.shutdownNow()
    }
  }

  @Test
  fun `manual flush`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.flush()

    assertEquals(1, flushed.size)
    assertEquals(2, flushed[0].size)
  }

  @Test
  fun `flush is no-op when empty`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.flush()
    assertEquals(0, flushed.size)
  }

  @Test
  fun `shutdown flushes remaining events`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val executorThreadName = "SdkEventBuffer-shutdown-executor"
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, executorThreadName)
    }
    val flushThread = AtomicReference<String>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = {
          flushThread.set(Thread.currentThread().name)
          flushed.add(it)
        },
        executor = executor,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.shutdown()

    assertTrue(
      executor.awaitTermination(1, TimeUnit.SECONDS),
      "Shutdown should drain queued delivery",
    )
    assertEquals(1, flushed.size)
    assertEquals(2, flushed[0].size)
    assertEquals(executorThreadName, flushThread.get())
  }

  @Test
  fun `shutdown drains queued capacity and pending batches on executor`() {
    val executorThreadName = "SdkEventBuffer-shutdown-drain-executor"
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, executorThreadName)
    }
    val deliveryStarted = CountDownLatch(1)
    val releaseDelivery = CountDownLatch(1)
    val deliveries = CopyOnWriteArrayList<List<SdkEvent>>()
    val deliveryThreads = CopyOnWriteArrayList<String>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 2,
        flushIntervalMs = 60_000,
        onFlush = { events ->
          deliveries.add(ArrayList(events))
          deliveryThreads.add(Thread.currentThread().name)
          if (events.first().timestamp == 1L) {
            deliveryStarted.countDown()
            releaseDelivery.await()
          }
        },
        executor = executor,
      )

    try {
      buffer.add(makeEvent(1))
      buffer.add(makeEvent(2))
      assertTrue(deliveryStarted.await(1, TimeUnit.SECONDS), "Capacity delivery should be queued")

      buffer.add(makeEvent(3))
      buffer.shutdown()
      releaseDelivery.countDown()

      assertTrue(
        executor.awaitTermination(1, TimeUnit.SECONDS),
        "Shutdown should drain both batches",
      )
      assertEquals(listOf(1L, 2L, 3L), deliveries.flatten().map { it.timestamp })
      assertEquals(listOf(executorThreadName, executorThreadName), deliveryThreads)
    } finally {
      releaseDelivery.countDown()
      executor.shutdownNow()
    }
  }

  @Test
  fun `add after shutdown is ignored`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.shutdown()
    buffer.add(makeEvent(1))

    // Only the shutdown flush, which was empty
    assertEquals(0, flushed.size)
  }

  @Test
  fun `thread safety - concurrent adds`() {
    val flushed = CopyOnWriteArrayList<List<SdkEvent>>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 50,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(ArrayList(it)) },
        executor = executor,
      )

    val latch = CountDownLatch(1)
    val threads =
      (1..10).map { threadNum ->
        Thread {
          latch.await()
          for (i in 1..10) {
            buffer.add(makeEvent(threadNum * 100 + i))
          }
        }
      }

    threads.forEach { it.start() }
    latch.countDown()
    threads.forEach { it.join(5000) }
    drainExecutor(executor) // wait for any capacity flushes
    buffer.flush()

    val totalEvents = flushed.sumOf { it.size }
    assertEquals(100, totalEvents, "All 100 events should be flushed")
  }

  @Test
  fun `add when disabled is ignored`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.isEnabled = false
    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.flush()

    assertEquals(0, flushed.size, "No events should be buffered when disabled")
  }

  @Test
  fun `re-enabling allows events again`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.isEnabled = false
    buffer.add(makeEvent(1))

    buffer.isEnabled = true
    buffer.add(makeEvent(2))
    buffer.flush()

    assertEquals(1, flushed.size, "Should flush after re-enabling")
    assertEquals(1, flushed[0].size, "Only the event added after re-enabling should be present")
  }

  @Test
  fun `flush error counts each dropped event`() {
    val counter = DefaultDropCounter()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 5,
        flushIntervalMs = 60_000,
        onFlush = { throw RuntimeException("delivery failed") },
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
          if (callCount == 1) throw RuntimeException("test error")
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
        processors = listOf(EventProcessor { throw RuntimeException("processor failed") }),
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
              if (shouldThrow) throw RuntimeException("fail")
              event
            }
          ),
      )

    buffer.add(makeEvent(1)) // dropped due to processor error
    shouldThrow = false
    buffer.add(makeEvent(2)) // should succeed
    buffer.flush()

    assertEquals(1, flushed.size, "Second event should be buffered after first processor failure")
    assertEquals(1, flushed[0].size)
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

  // ============ Delivery-failure persistence + churn (#3605, #3710) =========

  /** Always throws from persist() — persist is best-effort on the failure path. */
  private class ThrowingPersistence : EventPersistence {
    override fun persist(events: List<SdkEvent>): String? = throw RuntimeException("boom")

    override fun loadPending(): List<Pair<String, List<SdkEvent>>> = emptyList()

    override fun removeBatch(batchId: String) {}

    override fun cleanup(maxAgeDays: Int) {}
  }

  /** Counts persist() calls so we can assert the happy path never writes to disk. */
  private class CountingPersistence : EventPersistence {
    val persistCount = AtomicInteger(0)

    override fun persist(events: List<SdkEvent>): String? {
      persistCount.incrementAndGet()
      return "batch-id"
    }

    override fun loadPending(): List<Pair<String, List<SdkEvent>>> = emptyList()

    override fun removeBatch(batchId: String) {}

    override fun cleanup(maxAgeDays: Int) {}
  }

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
          if (deliveries == 1) throw RuntimeException("delivery failed")
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
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1_000,
        flushIntervalMs = 60_000,
        onFlush = { throw RuntimeException("delivery failed") },
        persistence = persistence,
      )

    buffer.add(makeEvent(1))
    buffer.flush()

    assertEquals(1, persistence.persistCount.get())
  }
}
