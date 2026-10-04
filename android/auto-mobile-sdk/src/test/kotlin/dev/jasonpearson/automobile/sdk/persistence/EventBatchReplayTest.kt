package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryOutcome
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.Test

class EventBatchReplayTest {
  private class QueuedBackground {
    val tasks = ArrayDeque<Runnable>()

    fun execute(task: Runnable) {
      tasks.addLast(task)
    }

    fun runNext() {
      val task = tasks.removeFirst()
      val error = AtomicReference<Throwable>()
      val worker =
        Thread(
          {
            try {
              task.run()
            } catch (failure: Throwable) {
              error.set(failure)
            }
          },
          "replay-test-background",
        )
      worker.isDaemon = true
      worker.start()
      worker.join(1000)
      assertFalse(worker.isAlive, "Background task should complete without blocking")
      error.get()?.let { throw it }
    }

    fun drain() {
      while (tasks.isNotEmpty()) runNext()
    }
  }

  private class FakePersistence(count: Int) : EventPersistence {
    val pending =
      (1..count)
        .map { index ->
          PendingEventBatch(
            "batch-$index",
            listOf<SdkEvent>(SdkLifecycleEvent(timestamp = index.toLong(), kind = "$index")),
          )
        }
        .toMutableList()
    val removed = mutableListOf<String>()
    val failures = mutableListOf<String>()
    val operationThreads = mutableListOf<Thread>()
    var throwOnRemove = false
    var throwOnFailure = false

    override fun persist(events: List<SdkEvent>, deliveryId: String?): String? =
      error("Replay must not persist duplicates")

    override fun loadPending(): List<PendingEventBatch> = pending.toList()

    override fun removeBatch(batchId: String) {
      operationThreads.add(Thread.currentThread())
      if (throwOnRemove) error("remove failed")
      removed.add(batchId)
      pending.removeAll { it.storageId == batchId }
    }

    override fun recordReplayFailure(batchId: String): Boolean {
      operationThreads.add(Thread.currentThread())
      if (throwOnFailure) error("attempt recording failed")
      failures.add(batchId)
      return true
    }

    override fun cleanup(maxAgeDays: Int) {}
  }

  @Test
  fun `successful completion removes batch off callback thread and chains next delivery`() {
    val persistence = FakePersistence(2)
    val background = QueuedBackground()
    val delivered = mutableListOf<Long>()
    val deliveryThreads = mutableListOf<Thread>()
    val completions = mutableListOf<(Boolean) -> Unit>()
    replayEventBatches(persistence, background::execute) { events, _, complete ->
      delivered.add(events.single().timestamp)
      deliveryThreads.add(Thread.currentThread())
      completions.add(complete)
    }
    assertEquals(listOf(1L), delivered)
    val callbackThread = Thread.currentThread()
    completions[0](true)
    assertTrue(persistence.removed.isEmpty())
    assertEquals(listOf(1L), delivered)
    background.runNext()
    assertEquals(listOf("batch-1"), persistence.removed)
    assertEquals(listOf(1L, 2L), delivered)
    assertNotEquals(callbackThread, persistence.operationThreads.single())
    assertNotEquals(callbackThread, deliveryThreads[1])
    completions[1](true)
    background.drain()
    assertEquals(listOf("batch-1", "batch-2"), persistence.removed)
  }

  @Test
  fun `legacy failed completion records attempt off callback thread and continues`() {
    val persistence = FakePersistence(2)
    val background = QueuedBackground()
    val completions = mutableListOf<(Boolean) -> Unit>()
    replayEventBatches(persistence, background::execute) { _, _, complete ->
      completions.add(complete)
    }
    val callbackThread = Thread.currentThread()
    completions[0](false)
    assertTrue(persistence.failures.isEmpty())
    assertEquals(1, completions.size)
    background.runNext()
    assertEquals(listOf("batch-1"), persistence.failures)
    assertNotEquals(callbackThread, persistence.operationThreads.single())
    assertEquals(2, completions.size)
    assertEquals(2, persistence.pending.size)
    assertTrue(persistence.removed.isEmpty())
  }

  @Test
  fun `rejected completion hop retains files and stops chain`() {
    val persistence = FakePersistence(2)
    val completions = mutableListOf<(Boolean) -> Unit>()
    replayEventBatches(persistence, { throw RejectedExecutionException("stopped") }) {
      _,
      _,
      complete ->
      completions.add(complete)
    }
    completions.single()(true)
    assertEquals(2, persistence.pending.size)
    assertTrue(persistence.operationThreads.isEmpty())
    assertEquals(1, completions.size)
  }

  @Test
  fun `ignored completion hop leaves failed batch without consuming an attempt`() {
    val persistence = FakePersistence(2)
    val completions = mutableListOf<(Boolean) -> Unit>()
    replayEventBatches(persistence, {}) { _, _, complete -> completions.add(complete) }
    completions.single()(false)
    assertEquals(2, persistence.pending.size)
    assertTrue(persistence.failures.isEmpty())
    assertEquals(1, completions.size)
  }

  @Test
  fun `launch replays at most twenty batches leaving the rest for later`() {
    val persistence = FakePersistence(MAX_REPLAY_BATCHES_PER_LAUNCH + 3)
    val background = QueuedBackground()
    var deliveries = 0
    replayEventBatches(persistence, background::execute) { _, _, complete ->
      deliveries++
      complete(true)
    }
    assertEquals(1, deliveries)
    background.drain()
    assertEquals(MAX_REPLAY_BATCHES_PER_LAUNCH, deliveries)
    assertEquals(
      listOf("batch-21", "batch-22", "batch-23"),
      persistence.pending.map { it.storageId },
    )
  }

  @Test
  fun `legacy throwing delivery records failure and continues chain`() {
    val persistence = FakePersistence(2)
    val background = QueuedBackground()
    val delivered = mutableListOf<Long>()
    replayEventBatches(persistence, background::execute) { events, _, complete ->
      delivered.add(events.single().timestamp)
      if (events.single().timestamp == 1L) error("delivery failed")
      complete(true)
    }
    assertTrue(persistence.failures.isEmpty())
    background.drain()
    assertEquals(listOf(1L, 2L), delivered)
    assertEquals(listOf("batch-1"), persistence.failures)
    assertEquals(listOf("batch-2"), persistence.removed)
  }

  @Test
  fun `never completing delivery stops chain without modifying any file`() {
    val persistence = FakePersistence(3)
    val background = QueuedBackground()
    var deliveries = 0
    replayEventBatches(persistence, background::execute) { _, _, _ -> deliveries++ }
    assertEquals(1, deliveries)
    assertTrue(background.tasks.isEmpty())
    assertTrue(persistence.operationThreads.isEmpty())
  }

  @Test
  fun `duplicate completion and throw after completion advance chain only once`() {
    val persistence = FakePersistence(2)
    val background = QueuedBackground()
    var deliveries = 0
    replayEventBatches(persistence, background::execute) { _, _, complete ->
      deliveries++
      complete(true)
      complete(false)
      error("threw after completion")
    }
    background.drain()
    assertEquals(2, deliveries)
    assertEquals(listOf("batch-1", "batch-2"), persistence.removed)
    assertTrue(persistence.failures.isEmpty())
  }

  @Test
  fun `legacy persistence completion errors are contained and continue replay`() {
    for (success in listOf(true, false)) {
      val persistence = FakePersistence(2)
      persistence.throwOnRemove = true
      persistence.throwOnFailure = true
      val background = QueuedBackground()
      var deliveries = 0
      replayEventBatches(persistence, background::execute) { _, _, complete ->
        deliveries++
        complete(success)
      }
      background.drain()
      assertEquals(2, deliveries)
      assertEquals(2, persistence.pending.size)
    }
  }

  @Test
  fun `explicit rejection consumes one attempt and stops FIFO replay`() {
    val persistence = FakePersistence(2)
    val background = QueuedBackground()
    var deliveries = 0
    EventBatchReplay().replay(persistence, background::execute) { _, _, complete ->
      deliveries++
      complete(BatchDeliveryOutcome.REJECTED)
    }
    background.drain()
    assertEquals(1, deliveries)
    assertEquals(listOf("batch-1"), persistence.failures)
    assertEquals(2, persistence.pending.size)
  }
}
