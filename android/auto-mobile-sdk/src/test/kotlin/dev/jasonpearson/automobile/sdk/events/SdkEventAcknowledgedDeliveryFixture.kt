package dev.jasonpearson.automobile.sdk.events

import android.content.Context
import android.content.ContextWrapper
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.NoOpEventPersistence
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch
import java.util.concurrent.Delayed
import java.util.concurrent.FutureTask
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.BeforeClass

internal abstract class SdkEventAcknowledgedDeliveryFixture {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmUpDelivery() {
      // Warm the JVM/serialization classes once, outside the per-test timing budget.
      val fixture = object : SdkEventAcknowledgedDeliveryFixture() {}
      fixture.setUp()
      fixture.sender.response = 1000
      fixture.send("warmup")
      fixture.tearDown()
    }
  }

  protected class FakeTimer : BatchDeliveryScheduler {
    private data class Task(val at: Long, val runnable: Runnable, var cancelled: Boolean = false)

    private val tasks = mutableListOf<Task>()
    private var now = 0L
    var deferCompletions = false
    private val completions = ArrayDeque<Runnable>()

    override fun execute(task: Runnable) {
      if (deferCompletions) completions.addLast(task) else task.run()
    }

    fun drainCompletions() {
      while (completions.isNotEmpty()) completions.removeFirst().run()
    }

    override fun schedule(task: Runnable, delayMs: Long): () -> Unit {
      val scheduled = Task(now + delayMs, task)
      tasks.add(scheduled)
      return { scheduled.cancelled = true }
    }

    fun advance(ms: Long) {
      now += ms
      while (true) {
        val next = tasks.firstOrNull { !it.cancelled && it.at <= now } ?: return
        next.cancelled = true
        next.runnable.run()
      }
    }
  }

  protected class FakeStore : NoOpEventPersistence() {
    val pending = mutableListOf<PendingEventBatch>()
    val removed = mutableListOf<String>()
    var writes = 0
    val failures = mutableListOf<String>()
    var refuseRemove = false

    override fun persist(events: List<SdkEvent>, deliveryId: String?): String {
      val id = "${++writes}"
      pending.add(PendingEventBatch(id, events, deliveryId))
      return id
    }

    override fun loadPending(): List<PendingEventBatch> = pending.toList()

    override fun removeBatch(batchId: String) {
      removed.add(batchId)
      if (!refuseRemove) pending.removeAll { it.storageId == batchId }
    }

    override fun recordReplayFailure(batchId: String): Boolean {
      failures.add(batchId)
      return true
    }
  }

  protected class BroadcastContext : ContextWrapper(null) {
    override fun getPackageName(): String = "com.test.app"
  }

  protected class FakeSender : BatchBroadcastSender {
    var plainSends = 0
    val ordered = mutableListOf<String>()
    val results = mutableListOf<(Int) -> Unit>()
    val batchIds = mutableListOf<String?>()
    val plainBatchIds = mutableListOf<String?>()
    var afterSend: () -> Unit = {}
    var response: Int? = null
    var throwsRemaining = 0
    var attempts = 0
    var throwForBatchId: String? = null
    val attemptedBatchIds = mutableListOf<String?>()

    override fun send(
      context: Context,
      batchJson: String,
      batchId: String?,
      ordered: Boolean,
      onResult: (Int) -> Unit,
    ) {
      attempts++
      attemptedBatchIds.add(batchId)
      if (batchId != null && batchId == throwForBatchId) throw SecurityException("send refused")
      if (throwsRemaining-- > 0) throw IllegalStateException("broadcast failed")
      if (!ordered) {
        plainSends++
        plainBatchIds.add(batchId)
        afterSend()
        return
      }
      batchIds.add(batchId)
      this.ordered.add(batchJson)
      results.add(onResult)
      response?.let { respond(results.lastIndex, it) }
      afterSend()
    }

    fun respond(index: Int, code: Int) = results[index](code)
  }

  protected lateinit var timer: FakeTimer
  protected lateinit var context: BroadcastContext
  protected lateinit var sender: FakeSender
  protected lateinit var store: FakeStore
  protected lateinit var drops: DefaultDropCounter

  @Before
  fun setUp() {
    SdkEventBroadcaster.reset()
    timer = FakeTimer()
    context = BroadcastContext()
    sender = FakeSender()
    SdkEventBroadcaster.broadcastSender = sender
    store = FakeStore()
    drops = DefaultDropCounter()
    SdkEventBroadcaster.deliveryScheduler = timer
    SdkEventBroadcaster.dropCounter = drops
    SdkEventBroadcaster.capabilityGate = SdkEventAckCapability(AckPackageInfoReader { true }, { 0 })
  }

  @After
  fun tearDown() {
    SdkEventBroadcaster.reset()
  }

  protected fun event(name: String) = SdkLifecycleEvent(timestamp = 1, kind = name)

  protected fun send(name: String, onAcknowledged: () -> Unit = {}): List<Boolean> {
    val completions = mutableListOf<Boolean>()
    SdkEventBroadcaster.broadcastBatch(
      context,
      listOf(event(name)),
      onUndelivered = { events, id -> store.persist(events, id) },
      onComplete = completions::add,
      onAcknowledged = onAcknowledged,
    )
    return completions
  }

  /** Virtual executor: no workers or clock waits; shutdown observes only live delayed work. */
  protected class FakeBufferExecutor : ScheduledThreadPoolExecutor(1) {
    private class Task(command: Runnable, val at: Long, val onCancel: () -> Unit) :
      FutureTask<Unit>(command, Unit), ScheduledFuture<Unit> {
      override fun cancel(mayInterruptIfRunning: Boolean): Boolean {
        onCancel()
        return super.cancel(mayInterruptIfRunning)
      }

      override fun getDelay(unit: TimeUnit): Long = unit.convert(at, TimeUnit.MILLISECONDS)

      override fun compareTo(other: Delayed): Int =
        getDelay(TimeUnit.MILLISECONDS).compareTo(other.getDelay(TimeUnit.MILLISECONDS))
    }

    private val immediate = ArrayDeque<Runnable>()
    private val delayed = mutableListOf<Task>()
    private var stopped = false
    private var now = 0L
    var liveDelaysAtTermination = -1
    var rejectedSchedules = 0
    var schedules = 0
    var failCancellationAt: Int? = null

    override fun execute(command: Runnable) {
      check(!stopped)
      immediate.addLast(command)
    }

    override fun schedule(command: Runnable, delay: Long, unit: TimeUnit): ScheduledFuture<*> {
      if (stopped) {
        rejectedSchedules++
        throw RejectedExecutionException("shutdown")
      }
      val scheduleIndex = ++schedules
      return Task(command, now + unit.toMillis(delay)) {
          if (scheduleIndex == failCancellationAt) {
            failCancellationAt = null
            throw IllegalStateException("timeout cancellation failed")
          }
        }
        .also { delayed.add(it) }
    }

    override fun isShutdown(): Boolean = stopped

    override fun shutdown() {
      stopped = true
    }

    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean {
      drain()
      liveDelaysAtTermination = delayed.count { !it.isDone }
      return true
    }

    fun drain() {
      while (immediate.isNotEmpty()) immediate.removeFirst().run()
    }

    fun advance(ms: Long) {
      now += ms
      delayed.filter { !it.isDone && it.at <= now }.forEach { it.run() }
      drain()
    }
  }

  protected fun realBuffer(executor: FakeBufferExecutor): SdkEventBuffer {
    lateinit var buffer: SdkEventBuffer
    buffer =
      SdkEventBuffer(
        onFlush = { SdkEventBroadcaster.broadcastBatch(context, it, buffer::persistUndelivered) },
        persistence = store,
        executor = executor,
        dropCounter = drops,
        // Shutdown work must drain on the existing buffer worker, never spawn a fallback worker.
        persistenceExecutor = java.util.concurrent.Executor { error("Unexpected fallback") },
      )
    SdkEventBroadcaster.deliveryScheduler =
      object : BatchDeliveryScheduler {
        override fun schedule(task: Runnable, delayMs: Long): (() -> Unit)? =
          buffer.scheduleDelivery(task, delayMs)

        override fun execute(task: Runnable) = buffer.executeDelivery(task)
      }
    return buffer
  }

  protected fun assertContainedSendFailure(failedChunk: Int, requireAck: Boolean) {
    SdkEventBroadcaster.capabilityGate =
      SdkEventAckCapability(AckPackageInfoReader { requireAck }, { 0 })
    // Ack retries use the virtual executor. The legacy pin exhausts retries immediately.
    SdkEventBroadcaster.retryPolicy =
      RetryPolicy(maxRetries = if (requireAck) 1 else 0, baseDelayMs = 0)
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    val events = (1..3).map { event("chunk-$it-" + "x".repeat(60_000)) }
    var allocations = 0
    SdkEventBroadcaster.batchIdProvider = { "id-${++allocations}" }
    sender.throwForBatchId = "id-$failedChunk"
    sender.response = 1000
    if (!requireAck) executor.failCancellationAt = failedChunk
    try {
      events.forEach(buffer::add)
      buffer.flush()
      assertEquals(listOf<String?>("id-1", "id-2", "id-3"), sender.attemptedBatchIds)
      assertEquals(0, store.writes, "Persistence must stay queued off the flush caller")
      executor.advance(0)
      assertEquals(listOf(events[failedChunk - 1]), store.pending.single().events)
      assertEquals("id-$failedChunk", store.pending.single().deliveryId)
      assertTrue(drops.snapshot().isEmpty(), "A retained chunk is not a flush error or drop")
      val sentIds = if (requireAck) sender.batchIds else sender.plainBatchIds
      assertEquals<List<String?>>((1..3).filter { it != failedChunk }.map { "id-$it" }, sentIds)
      if (requireAck) {
        assertEquals("id-$failedChunk", sender.attemptedBatchIds.last())
        assertEquals(4, sender.attempts)
      } else {
        assertEquals(0, executor.schedules, "Legacy delivery never schedules an ack timeout")
      }
      executor.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
      assertEquals(1, store.writes, "Cancelled timeouts must not persist another copy")
    } finally {
      buffer.shutdown()
    }
  }
}
