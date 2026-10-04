package dev.jasonpearson.automobile.sdk.events

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.EventBatchReplay
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch
import java.util.concurrent.Delayed
import java.util.concurrent.FutureTask
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

class SdkEventAcknowledgedDeliveryTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmUpDelivery() {
      // Warm the JVM/serialization classes once, outside the per-test timing budget.
      val fixture = SdkEventAcknowledgedDeliveryTest()
      fixture.setUp()
      fixture.sender.response = 1000
      fixture.send("warmup")
      fixture.tearDown()
    }
  }

  private class FakeTimer : BatchDeliveryScheduler {
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

  private class FakeStore : EventPersistence {
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

    override fun cleanup(maxAgeDays: Int) {}
  }

  private class BroadcastContext : ContextWrapper(null) {
    override fun getPackageName(): String = "com.test.app"
  }

  private class FakeSender : BatchBroadcastSender {
    var plainSends = 0
    val ordered = mutableListOf<String>()
    val results = mutableListOf<(Int) -> Unit>()
    val batchIds = mutableListOf<String?>()
    val plainBatchIds = mutableListOf<String?>()
    var afterSend: () -> Unit = {}
    var response: Int? = null
    var throwsRemaining = 0
    var attempts = 0

    override fun send(
      context: Context,
      batchJson: String,
      batchId: String?,
      ordered: Boolean,
      onResult: (Int) -> Unit,
    ) {
      attempts++
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

  private lateinit var timer: FakeTimer
  private lateinit var context: BroadcastContext
  private lateinit var sender: FakeSender
  private lateinit var store: FakeStore
  private lateinit var drops: DefaultDropCounter

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

  private fun event(name: String) = SdkLifecycleEvent(timestamp = 1, kind = name)

  private fun send(name: String, onAcknowledged: () -> Unit = {}): List<Boolean> {
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

  @Test
  fun `absent flag and missing package preserve plain handoff without persistence`() {
    for (missing in listOf(false, true)) {
      SdkEventBroadcaster.capabilityGate =
        SdkEventAckCapability(
          AckPackageInfoReader {
            if (missing) throw PackageManager.NameNotFoundException("missing")
            false
          },
          { 0 },
        )
      assertEquals(listOf(true), send("legacy"))
    }
    assertEquals(2, sender.plainSends)
    assertTrue(sender.ordered.isEmpty())
    assertEquals(0, store.writes)
  }

  @Test
  fun `accepted result is delivered without persistence`() {
    sender.response = 1000
    var replayTriggers = 0
    assertEquals(listOf(true), send("accepted") { replayTriggers++ })
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(1, replayTriggers)
    assertEquals(0, store.writes)
    assertTrue(drops.snapshot().isEmpty())
  }

  @Test
  fun `no receiver and queue full results persist exact batch once`() {
    for (code in listOf(0, -1, 1001)) {
      sender.response = code
      assertEquals(listOf(false), send("$code"))
    }
    assertEquals(
      listOf("0", "-1", "1001"),
      store.pending.map { (it.events.single() as SdkLifecycleEvent).kind },
    )
    assertTrue(drops.snapshot().isEmpty())
  }

  @Test
  fun `invalid payload is dropped and counted once without persistence`() {
    sender.response = 1002
    assertEquals(listOf(false), send("invalid"))
    sender.respond(0, 1002)
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(0, store.writes)
    assertEquals(1L, drops.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `late result after timeout cannot persist or complete twice or trigger replay`() {
    var replayTriggers = 0
    val results = send("timeout") { replayTriggers++ }
    assertTrue(results.isEmpty())
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(listOf(false), results)
    sender.respond(0, 1000)
    sender.respond(0, 1002)
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(listOf(false), results)
    assertEquals(1, store.writes)
    assertEquals(0, replayTriggers)
    assertTrue(drops.snapshot().isEmpty())
  }

  @Test
  fun `later acknowledged flush replays pending once in FIFO order and removes it`() {
    sender.response = 0
    send("oldest")
    send("second")
    val originalIds = sender.batchIds.toList()
    assertEquals(2, originalIds.toSet().size)
    assertTrue(originalIds.all { it != null })
    val replay = EventBatchReplay()
    val replayed = mutableListOf<String>()
    sender.response = 1000
    send("flush") {
      replay.replay(store, { it.run() }) { events, deliveryId, complete ->
        replayed.add((events.single() as SdkLifecycleEvent).kind)
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onUndelivered = { _, _ -> },
          onFinished = complete,
          splitBatches = false,
          batchId = deliveryId,
        )
      }
    }
    assertEquals(listOf("oldest", "second"), replayed)
    assertEquals(listOf("1", "2"), store.removed)
    assertEquals(2, store.writes)
    assertTrue(store.pending.isEmpty())
    assertEquals(5, sender.ordered.size)
    assertEquals(originalIds, sender.batchIds.takeLast(2))
  }

  @Test
  fun `unacknowledged replay stops retains rest and prevents overlapping passes`() {
    store.persist(listOf(event("first")))
    store.persist(listOf(event("second")))
    val replay = EventBatchReplay()
    val deliver: (List<SdkEvent>, String?, (BatchDeliveryOutcome) -> Unit) -> Unit =
      { events, deliveryId, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onUndelivered = { _, _ -> },
          onFinished = complete,
          splitBatches = false,
          batchId = deliveryId,
        )
      }
    replay.replay(store, { it.run() }, deliver)
    replay.replay(store, { it.run() }, deliver)
    assertEquals(1, sender.ordered.size)
    sender.respond(0, 0)
    assertEquals(2, store.pending.size)
    assertTrue(store.removed.isEmpty())
    sender.response = 1000
    replay.replay(store, { it.run() }, deliver)
    assertTrue(store.pending.isEmpty())
    assertEquals(3, sender.ordered.size)
  }

  @Test
  fun `timeout followed by invalid result cannot count a retained event as dropped`() {
    send("timeout")
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    sender.respond(0, 1002)
    assertEquals(1, store.writes)
    assertFalse(store.pending.isEmpty())
    assertTrue(drops.snapshot().isEmpty())
  }

  @Test
  fun `invalid stored payload is counted and removed instead of replaying forever`() {
    store.persist(listOf(event("invalid")))
    store.persist(listOf(event("later")))
    sender.response = 1002
    val replay = EventBatchReplay()
    val deliver: (List<SdkEvent>, String?, (BatchDeliveryOutcome) -> Unit) -> Unit =
      { events, deliveryId, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onUndelivered = { _, _ -> },
          onFinished = complete,
          splitBatches = false,
          batchId = deliveryId,
        )
      }
    replay.replay(store, { it.run() }, deliver)
    assertTrue(store.pending.isEmpty())
    assertEquals(listOf("1", "2"), store.removed)
    assertEquals(2, sender.ordered.size)
    assertEquals(2L, drops.snapshot()[DropReason.DELIVERY_FAILED])
    sender.response = 1000
    replay.replay(store, { it.run() }, deliver)
    assertEquals(2, sender.ordered.size)
    assertEquals(2L, drops.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `result arrival wins before executor dispatch even if timeout becomes due`() {
    timer.deferCompletions = true
    sender.response = 1000
    val results = send("accepted")
    assertTrue(results.isEmpty())
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(0, store.writes)
    timer.drainCompletions()
    assertEquals(listOf(true), results)
    assertEquals(0, store.writes)
  }

  @Test
  fun `empty stored batch completes replay and releases the guard`() {
    store.pending.add(PendingEventBatch("empty", emptyList()))
    val replay = EventBatchReplay()
    val deliver: (List<SdkEvent>, String?, (BatchDeliveryOutcome) -> Unit) -> Unit =
      { events, deliveryId, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onFinished = complete,
          splitBatches = false,
          batchId = deliveryId,
        )
      }
    replay.replay(store, { it.run() }, deliver)
    assertTrue(store.pending.isEmpty())
    store.persist(listOf(event("next")))
    sender.response = 1000
    replay.replay(store, { it.run() }, deliver)
    assertTrue(store.pending.isEmpty())
    assertEquals(1, sender.ordered.size)
  }

  /** Virtual executor: no workers or clock waits; shutdown observes only live delayed work. */
  private class FakeBufferExecutor : ScheduledThreadPoolExecutor(1) {
    private class Task(command: Runnable, val at: Long) :
      FutureTask<Unit>(command, Unit), ScheduledFuture<Unit> {
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

    override fun execute(command: Runnable) {
      check(!stopped)
      immediate.addLast(command)
    }

    override fun schedule(command: Runnable, delay: Long, unit: TimeUnit): ScheduledFuture<*> {
      if (stopped) {
        rejectedSchedules++
        throw RejectedExecutionException("shutdown")
      }
      return Task(command, now + unit.toMillis(delay)).also { delayed.add(it) }
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

  private fun realBuffer(executor: FakeBufferExecutor): SdkEventBuffer {
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

  @Test
  fun `flush id allocation failure happens before any chunk is sent`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    val events = (1..2).map { event("chunk-$it-" + "x".repeat(60_000)) }
    var allocations = 0
    SdkEventBroadcaster.batchIdProvider = {
      check(++allocations != 2) { "id allocation failed" }
      "id-$allocations"
    }
    try {
      events.forEach(buffer::add)
      buffer.flush()
      assertTrue(sender.ordered.isEmpty(), "A preparation failure must not send a prefix")
      assertEquals(0, store.writes, "Persistence must stay queued off the flush caller")
      executor.drain()
      assertEquals(events, store.pending.single().events)
      assertEquals(null, store.pending.single().deliveryId)
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `flush serialization failure persists only unsent chunks with their allocated ids`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    var failSerialization = false
    val values = mapOf("key" to "value")
    val details =
      object : Map<String, String> by values {
        override val entries: Set<Map.Entry<String, String>>
          get() {
            check(!failSerialization) { "serialization failed" }
            return values.entries
          }
      }
    val events =
      (1..3).map {
        SdkLifecycleEvent(
          timestamp = 1,
          kind = "chunk-$it-" + "x".repeat(60_000),
          details = if (it == 2) details else null,
        )
      }
    var allocations = 0
    SdkEventBroadcaster.batchIdProvider = { "id-${++allocations}" }
    sender.response = 1000
    sender.afterSend = { failSerialization = true }
    try {
      events.forEach(buffer::add)
      buffer.flush()
      assertEquals(listOf<String?>("id-1"), sender.batchIds)
      assertEquals(0, store.writes, "Persistence must stay queued off the flush caller")
      executor.drain()
      assertEquals(listOf(listOf(events[1]), listOf(events[2])), store.pending.map { it.events })
      assertEquals(listOf<String?>("id-2", "id-3"), store.pending.map { it.deliveryId })
      assertEquals(2L, drops.snapshot()[DropReason.FLUSH_ERROR])
      failSerialization = false
      sender.afterSend = {}
      EventBatchReplay().replay(store, { it.run() }) { replayEvents, id, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          replayEvents,
          onUndelivered = { _, _ -> },
          onFinished = complete,
          splitBatches = false,
          batchId = id,
        )
      }
      executor.drain()
      assertEquals(listOf<String?>("id-1", "id-2", "id-3"), sender.batchIds)
      assertTrue(store.pending.isEmpty())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `replay gate changes preserve stored identity and legacy child ids`() {
    val events = (1..2).map { event("chunk-$it-" + "x".repeat(60_000)) }
    store.persist(events, "stored")
    store.refuseRemove = true
    var supported = false
    var now = 0L
    SdkEventBroadcaster.capabilityGate =
      SdkEventAckCapability(AckPackageInfoReader { supported }, { now }, refreshIntervalMs = 1)
    sender.response = 1000
    val replay = EventBatchReplay()
    for (acknowledged in listOf(false, true, false, true)) {
      supported = acknowledged
      now++
      replay.replay(store, { it.run() }) { replayEvents, id, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          replayEvents,
          onUndelivered = { _, _ -> },
          onFinished = complete,
          splitBatches = false,
          batchId = id,
        )
      }
    }
    assertEquals(
      List(2) { listOf<String?>("stored:0", "stored:1") }.flatten(),
      sender.plainBatchIds,
    )
    assertEquals(listOf<String?>("stored", "stored"), sender.batchIds)
    assertEquals(List(4) { "1" }, store.removed)
    assertEquals("stored", store.pending.single().deliveryId)
    assertEquals(1, store.writes)
    assertTrue(store.failures.isEmpty())
  }

  @Test
  fun `gate refresh between files in one replay respects each delivery outcome`() {
    sender.response = 1000
    for (initialSupport in listOf(false, true)) {
      store.persist(listOf(event("first")), "first-id")
      store.persist(listOf(event("second")), "second-id")
      var supported = initialSupport
      var now = 0L
      SdkEventBroadcaster.capabilityGate =
        SdkEventAckCapability(AckPackageInfoReader { supported }, { now }, refreshIntervalMs = 1)
      EventBatchReplay().replay(store, { it.run() }) { events, id, complete ->
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onUndelivered = { _, _ -> },
          onFinished = { outcome ->
            supported = !supported
            now++
            complete(outcome)
          },
          splitBatches = false,
          batchId = id,
        )
      }
      assertTrue(store.pending.isEmpty())
    }
    assertEquals(listOf<String?>("first-id", "second-id"), sender.plainBatchIds)
    assertEquals(listOf<String?>("second-id", "first-id"), sender.batchIds)
    assertEquals(listOf("1", "2", "3", "4"), store.removed)
    assertEquals(4, store.writes)
    assertTrue(store.failures.isEmpty())
  }

  @Test
  fun `shutdown final flush sends ordered batch and persists without scheduling after shutdown`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    buffer.add(event("final"))
    buffer.shutdown()
    assertEquals(1, sender.ordered.size)
    assertEquals(0, executor.rejectedSchedules)
    assertEquals(1, store.writes)
    assertEquals(0, executor.liveDelaysAtTermination)
    sender.respond(0, 1000)
    assertEquals(1, store.writes)
  }

  @Test
  fun `shutdown cancels in flight ack timeout without waiting or double persistence`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    buffer.add(event("inflight"))
    buffer.flush()
    assertEquals(1, sender.ordered.size)
    buffer.shutdown()
    assertEquals(0, executor.liveDelaysAtTermination)
    assertEquals(1, store.writes)
    assertEquals(0, executor.rejectedSchedules)
    sender.respond(0, 1000)
    executor.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(1, store.writes)
  }

  @Test
  fun `real buffer scheduleDelivery and executeDelivery dispatch and cancel deterministically`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    var calls = 0
    val cancel = buffer.scheduleDelivery(Runnable { calls++ }, 30)
    cancel!!.invoke()
    buffer.executeDelivery(Runnable { calls += 10 })
    assertEquals(0, calls)
    executor.advance(30)
    assertEquals(10, calls)
    val handle = buffer.scheduleDelivery(Runnable { calls++ }, 30)
    assertTrue(handle != null, "Scheduled delivery should return a cancellation handle")
    executor.advance(30)
    assertEquals(11, calls)
    buffer.shutdown()
  }

  @Test
  fun `ack exception retry waits for acknowledgement and cancels failed attempt timeout`() {
    sender.throwsRemaining = 1
    SdkEventBroadcaster.retryPolicy = RetryPolicy(maxRetries = 1, baseDelayMs = 0)
    val completions = send("retry")
    assertTrue(completions.isEmpty())
    timer.advance(0)
    assertEquals(2, sender.attempts)
    assertTrue(completions.isEmpty())
    sender.respond(0, 1000)
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(listOf(true), completions)
    assertEquals(0, store.writes)
  }

  @Test
  fun `mixed chunk acknowledgements retain only unavailable chunk and count invalid once`() {
    val events = (1..3).map { event("chunk-$it-" + "x".repeat(60_000)) }
    val completions = mutableListOf<Boolean>()
    SdkEventBroadcaster.broadcastBatch(
      context,
      events,
      onUndelivered = { events, id -> store.persist(events, id) },
      onComplete = completions::add,
    )
    assertEquals(3, sender.ordered.size)
    sender.respond(2, 1002)
    sender.respond(0, 1000)
    assertTrue(completions.isEmpty())
    sender.respond(1, 0)
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(listOf(false), completions)
    assertEquals(listOf(events[1]), store.pending.single().events)
    assertEquals(1L, drops.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `no receiver and timeout replays never consume persisted attempts`() {
    store.persist(listOf(event("pending")))
    for (response in listOf(0, -1, null)) {
      repeat(3) {
        sender.response = response
        EventBatchReplay().replay(store, { it.run() }) { events, deliveryId, complete ->
          SdkEventBroadcaster.broadcastBatch(
            context,
            events,
            onUndelivered = { _, _ -> },
            onFinished = complete,
            splitBatches = false,
            batchId = deliveryId,
          )
        }
        timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
      }
    }
    assertTrue(store.failures.isEmpty())
    assertEquals(1, store.pending.size)
  }

  @Test
  fun `invalid head with failed removal is skipped so later batch replays once per pass`() {
    store.persist(listOf(event("invalid")))
    store.persist(listOf(event("later")))
    store.refuseRemove = true
    val replay = EventBatchReplay()
    replay.replay(store, { it.run() }) { events, deliveryId, complete ->
      sender.response = if ((events.single() as SdkLifecycleEvent).kind == "invalid") 1002 else 1000
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = { _, _ -> },
        onFinished = complete,
        splitBatches = false,
        batchId = deliveryId,
      )
    }
    assertEquals(listOf("1", "2"), store.removed)
    assertEquals(2, sender.ordered.size)
    assertEquals(1L, drops.snapshot()[DropReason.DELIVERY_FAILED])
    assertEquals(2, store.pending.size)
  }

  @Test
  fun `gate off shutdown still sends plain final flush without persistence or ack scheduling`() {
    SdkEventBroadcaster.capabilityGate =
      SdkEventAckCapability(AckPackageInfoReader { false }, { 0 })
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    buffer.add(event("legacy-final"))
    buffer.shutdown()
    assertEquals(1, sender.plainSends)
    assertTrue(sender.ordered.isEmpty())
    assertEquals(0, store.writes)
    assertEquals(0, executor.liveDelaysAtTermination)
    assertEquals(0, executor.rejectedSchedules)
  }

  @Test
  fun `real buffer accepted result queues completion and cancels timeout before shutdown`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    buffer.add(event("accepted"))
    buffer.flush()
    sender.respond(0, 1000)
    buffer.shutdown()
    assertEquals(0, store.writes)
    assertEquals(0, executor.liveDelaysAtTermination)
    assertEquals(0, executor.rejectedSchedules)
  }

  @Test
  fun `shutdown during exception retry sends ordered retry once without waiting for its ack`() {
    sender.throwsRemaining = 1
    SdkEventBroadcaster.retryPolicy = RetryPolicy(maxRetries = 1, baseDelayMs = 0)
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    buffer.add(event("retry-on-shutdown"))
    buffer.flush()
    assertEquals(1, sender.attempts)
    buffer.shutdown()
    assertEquals(2, sender.attempts)
    assertEquals(1, sender.ordered.size)
    assertEquals(1, store.writes)
    assertEquals(0, executor.liveDelaysAtTermination)
    assertEquals(0, executor.rejectedSchedules)
  }

  @Test
  fun `shutdown between result arrival and executor dispatch persists failed outcome exactly once`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    SdkEventBroadcaster.deliveryScheduler =
      object : BatchDeliveryScheduler {
        override fun schedule(task: Runnable, delayMs: Long): (() -> Unit)? =
          buffer.scheduleDelivery(task, delayMs)

        override fun execute(task: Runnable) {
          buffer.shutdown()
          buffer.executeDelivery(task)
        }
      }
    buffer.add(event("arrival-race"))
    buffer.flush()
    sender.respond(0, 0)
    assertEquals(1, store.writes)
    assertEquals(0, executor.liveDelaysAtTermination)
    sender.respond(0, 1000)
    executor.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    assertEquals(1, store.writes)
  }
}
