package dev.jasonpearson.automobile.sdk.events

import android.content.ContextWrapper
import android.content.Intent
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch
import dev.jasonpearson.automobile.sdk.persistence.replayEventBatches
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
@LooperMode(LooperMode.Mode.PAUSED)
class SdkEventBroadcasterTest {
  @Before
  fun setUp() {
    SdkEventBroadcaster.reset()
    SdkEventBroadcaster.retryPolicy = RetryPolicy(maxRetries = 2, baseDelayMs = 0)
  }

  @After
  fun tearDown() {
    SdkEventBroadcaster.reset()
  }

  private class BroadcastContext(private val send: (Intent) -> Unit) :
    ContextWrapper(RuntimeEnvironment.getApplication()) {
    override fun sendBroadcast(intent: Intent) = send(intent)
  }

  @Test
  fun `batch id extra is stable across retries and distinct for split chunks`() {
    var nextId = 0
    SdkEventBroadcaster.batchIdProvider = { "batch-${++nextId}" }
    val sentIds = mutableListOf<String?>()
    val context = BroadcastContext {
      sentIds.add(it.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID))
      if (sentIds.size == 1) throw IllegalStateException("retry")
    }
    val events = (1..2).map { makeEvent("event-$it-" + "x".repeat(60_000)) }
    SdkEventBroadcaster.broadcastBatch(context, events)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(listOf<String?>("batch-1", "batch-2", "batch-1"), sentIds)
    assertEquals(2, nextId)
  }

  @Test
  fun `exhausted retries report each exact chunk once in order`() {
    val events = (1..3).map { makeEvent("event-$it-" + "x".repeat(60_000)) }
    val failed = mutableListOf<List<SdkEvent>>()
    var attempts = 0
    val context = BroadcastContext {
      attempts++
      throw IllegalStateException("unavailable")
    }
    val completions = mutableListOf<Boolean>()
    SdkEventBroadcaster.broadcastBatch(
      context,
      events,
      { events, _ -> failed.add(events) },
      completions::add,
    )
    assertTrue(failed.isEmpty())
    assertTrue(completions.isEmpty())
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(events.map { listOf(it) }, failed)
    assertEquals(9, attempts)
    assertEquals(listOf(false), completions)
  }

  @Test
  fun `successful handoff completes without undelivered callback`() {
    val failed = mutableListOf<List<SdkEvent>>()
    val completions = mutableListOf<Boolean>()
    val sent = mutableListOf<String>()
    val events = (1..3).map { makeEvent("event-$it-" + "x".repeat(60_000)) }
    val context = BroadcastContext {
      val batch =
        SdkEventSerializer.fromJson(it.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)!!)
          as SdkEventBatch
      sent.add((batch.events.single() as SdkLifecycleEvent).kind)
    }
    SdkEventBroadcaster.broadcastBatch(
      context,
      events,
      { events, _ -> failed.add(events) },
      completions::add,
    )
    assertEquals(events.map { (it as SdkLifecycleEvent).kind }, sent)
    assertTrue(failed.isEmpty())
    assertEquals(listOf(true), completions)
  }

  @Test
  fun `mixed chunk delivery reports only failed chunk`() {
    val events = (1..3).map { makeEvent("event-$it-" + "x".repeat(60_000)) }
    val failed = mutableListOf<List<SdkEvent>>()
    val completions = mutableListOf<Boolean>()
    val context = BroadcastContext {
      if (it.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)!!.contains("event-2-")) {
        throw IllegalStateException("unavailable")
      }
    }
    SdkEventBroadcaster.broadcastBatch(
      context,
      events,
      { events, _ -> failed.add(events) },
      completions::add,
    )
    assertTrue(completions.isEmpty())
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(listOf(listOf(events[1])), failed)
    assertEquals(listOf(false), completions)
  }

  @Test
  fun `completion waits for retried chunk handoff`() {
    var attempts = 0
    val completions = mutableListOf<Boolean>()
    val failed = mutableListOf<List<SdkEvent>>()
    val context = BroadcastContext {
      if (attempts++ == 0) throw IllegalStateException("retry")
    }
    SdkEventBroadcaster.broadcastBatch(
      context,
      listOf(makeEvent("one")),
      { events, _ -> failed.add(events) },
      completions::add,
    )
    assertTrue(completions.isEmpty())
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(listOf(true), completions)
    assertTrue(failed.isEmpty())
  }

  @Test
  fun `reset cancels failure and completion callbacks`() {
    val failed = mutableListOf<List<SdkEvent>>()
    val completions = mutableListOf<Boolean>()
    val counter = DefaultDropCounter()
    SdkEventBroadcaster.dropCounter = counter
    val context = BroadcastContext { throw IllegalStateException("unavailable") }
    SdkEventBroadcaster.broadcastBatch(
      context,
      listOf(makeEvent("one")),
      { events, _ -> failed.add(events) },
      completions::add,
    )
    SdkEventBroadcaster.reset()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertTrue(failed.isEmpty())
    assertTrue(completions.isEmpty())
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `unhandled terminal failure counts actual chunk events`() {
    val counter = DefaultDropCounter()
    SdkEventBroadcaster.dropCounter = counter
    val events = (1..3).map { makeEvent("event-$it-" + "x".repeat(60_000)) }
    val context = BroadcastContext { throw IllegalStateException("unavailable") }
    SdkEventBroadcaster.broadcastBatch(context, events)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(3L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `unhandled failure counts uneven chunk accurately`() {
    val events =
      (1..5).map {
        makeEvent("event-$it-" + if (it >= 4) "x".repeat(60_000) else "")
      }
    val counter = DefaultDropCounter()
    SdkEventBroadcaster.dropCounter = counter
    val context = BroadcastContext {
      if (it.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)!!.contains("event-1-")) {
        throw IllegalStateException("unavailable")
      }
    }
    SdkEventBroadcaster.broadcastBatch(context, events)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  private class RecordingPersistence : EventPersistence {
    val persisted = mutableListOf<List<SdkEvent>>()
    val removed = mutableListOf<String>()

    override fun persist(events: List<SdkEvent>, deliveryId: String?): String {
      persisted.add(events)
      return "id"
    }

    override fun loadPending(): List<PendingEventBatch> =
      listOf(
        PendingEventBatch("original", listOf(SdkLifecycleEvent(timestamp = 1L, kind = "replay")))
      )

    override fun removeBatch(batchId: String) {
      removed.add(batchId)
    }

    override fun cleanup(maxAgeDays: Int) {}
  }

  @Test
  fun `terminal broadcaster failure reaches buffer persistence without double counting`() {
    val persistence = RecordingPersistence()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val counter = DefaultDropCounter()
    SdkEventBroadcaster.dropCounter = counter
    val context = BroadcastContext { throw IllegalStateException("unavailable") }
    lateinit var buffer: SdkEventBuffer
    buffer =
      SdkEventBuffer(
        onFlush = { SdkEventBroadcaster.broadcastBatch(context, it, buffer::persistUndelivered) },
        persistence = persistence,
        executor = executor,
        dropCounter = counter,
      )
    val events = listOf(makeEvent("one"), makeEvent("two"))
    try {
      events.forEach(buffer::add)
      buffer.flush()
      assertTrue(persistence.persisted.isEmpty())
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
      executor.submit {}.get(1, TimeUnit.SECONDS)
      assertEquals(listOf(events), persistence.persisted)
      assertTrue(counter.snapshot().isEmpty())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `successful broadcaster delivery through buffer does not persist`() {
    val persistence = RecordingPersistence()
    lateinit var buffer: SdkEventBuffer
    val context = BroadcastContext {}
    buffer =
      SdkEventBuffer(
        onFlush = { SdkEventBroadcaster.broadcastBatch(context, it, buffer::persistUndelivered) },
        persistence = persistence,
      )
    try {
      buffer.add(makeEvent("one"))
      buffer.flush()
      ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
      assertTrue(persistence.persisted.isEmpty())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `replay waits for successful retry before removing original`() {
    val persistence = RecordingPersistence()
    var attempts = 0
    val context = BroadcastContext {
      if (attempts++ == 0) throw IllegalStateException("retry")
    }
    replayEventBatches(persistence, { it.run() }) { events, deliveryId, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = { _, _ -> },
        onComplete = complete,
        splitBatches = false,
        batchId = deliveryId,
      )
    }
    assertTrue(persistence.removed.isEmpty())
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(listOf("original"), persistence.removed)
    assertTrue(persistence.persisted.isEmpty())
  }

  @Test
  fun `failed replay retains original without a duplicate or delivery drop`() {
    val persistence = RecordingPersistence()
    val counter = DefaultDropCounter()
    SdkEventBroadcaster.dropCounter = counter
    val context = BroadcastContext { throw IllegalStateException("unavailable") }
    replayEventBatches(persistence, { it.run() }) { events, deliveryId, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = { _, _ -> },
        onComplete = complete,
        splitBatches = false,
        batchId = deliveryId,
      )
    }
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertTrue(persistence.removed.isEmpty())
    assertTrue(persistence.persisted.isEmpty())
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `reset during replay retains original without repersisting`() {
    val persistence = RecordingPersistence()
    val context = BroadcastContext { throw IllegalStateException("unavailable") }
    replayEventBatches(persistence, { it.run() }) { events, deliveryId, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = { _, _ -> },
        onComplete = complete,
        splitBatches = false,
        batchId = deliveryId,
      )
    }
    SdkEventBroadcaster.reset()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertTrue(persistence.removed.isEmpty())
    assertTrue(persistence.persisted.isEmpty())
  }

  @Test
  fun `gate off exception retries exclusively on retryHandler`() {
    SdkEventBroadcaster.capabilityGate =
      SdkEventAckCapability(AckPackageInfoReader { false }, { 0 })
    SdkEventBroadcaster.deliveryScheduler =
      object : BatchDeliveryScheduler {
        override fun schedule(task: Runnable, delayMs: Long): () -> Unit =
          error("Legacy retries must use retryHandler")

        override fun execute(task: Runnable) = error("Legacy completion must stay inline")
      }
    var attempts = 0
    val completions = mutableListOf<Boolean>()
    val context = BroadcastContext {
      if (attempts++ == 0) throw IllegalStateException("retry")
    }
    SdkEventBroadcaster.broadcastBatch(
      context,
      listOf(makeEvent("legacy")),
      onComplete = completions::add,
    )
    assertEquals(1, attempts)
    assertTrue(completions.isEmpty())
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(2, attempts)
    assertEquals(listOf(true), completions)
  }

  @Test
  fun `gate off replay continues after exhausted broadcast retries`() {
    SdkEventBroadcaster.capabilityGate =
      SdkEventAckCapability(AckPackageInfoReader { false }, { 0 })
    val removed = mutableListOf<String>()
    val failures = mutableListOf<String>()
    val persistence =
      object : EventPersistence {
        override fun persist(events: List<SdkEvent>, deliveryId: String?): String? =
          error("No duplicate files")

        override fun loadPending() =
          listOf(
            PendingEventBatch("failed", listOf(makeEvent("failed"))),
            PendingEventBatch("later", listOf(makeEvent("later"))),
          )

        override fun removeBatch(batchId: String) {
          removed.add(batchId)
        }

        override fun recordReplayFailure(batchId: String): Boolean {
          failures.add(batchId)
          return true
        }

        override fun cleanup(maxAgeDays: Int) {}
      }
    val context = BroadcastContext {
      if (it.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)!!.contains("failed")) {
        throw IllegalStateException("unavailable")
      }
    }
    dev.jasonpearson.automobile.sdk.persistence.EventBatchReplay().replay(
      persistence,
      { it.run() },
    ) { events, deliveryId, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = { _, _ -> },
        onFinished = complete,
        splitBatches = false,
        batchId = deliveryId,
      )
    }
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    assertEquals(listOf("failed"), failures)
    assertEquals(listOf("later"), removed)
  }

  @Test
  fun `gate off replay preserves legacy chunk splitting even for a stored delivery unit`() {
    SdkEventBroadcaster.capabilityGate =
      SdkEventAckCapability(AckPackageInfoReader { false }, { 0 })
    val events = (1..3).map { makeEvent("chunk-$it-" + "x".repeat(60_000)) }
    val ids = mutableListOf<String?>()
    val context = BroadcastContext {
      ids.add(it.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID))
    }
    SdkEventBroadcaster.broadcastBatch(context, events, splitBatches = false)
    assertEquals(List<String?>(3) { null }, ids)
    ids.clear()
    repeat(2) {
      SdkEventBroadcaster.broadcastBatch(context, events, splitBatches = false, batchId = "stored")
    }
    assertEquals(List(2) { listOf<String?>("stored:0", "stored:1", "stored:2") }.flatten(), ids)
  }

  private fun makeEvent(name: String): SdkEvent =
    SdkLifecycleEvent(
      timestamp = 1000L,
      kind = name,
    )

  @Test
  fun `empty events returns empty list`() {
    val batches = SdkEventBroadcaster.splitIntoBatches(emptyList(), "com.example")
    assertTrue(batches.isEmpty())
  }

  @Test
  fun `single small event returns one batch`() {
    val events = listOf(makeEvent("click"))
    val batches = SdkEventBroadcaster.splitIntoBatches(events, "com.example")
    assertEquals(1, batches.size)
    assertTrue(batches[0].contains("click"))
  }

  @Test
  fun `batch under limit returns single json`() {
    val events = (1..5).map { makeEvent("event-$it") }
    val batches = SdkEventBroadcaster.splitIntoBatches(events, "com.example")
    assertEquals(1, batches.size)
  }

  @Test
  fun `batch over limit splits into multiple`() {
    val events = (1..10).map { makeEvent("event-$it") }
    // Use a very small max to force splitting
    val batches = SdkEventBroadcaster.splitIntoBatches(events, "com.example", maxBytes = 200)
    assertTrue(batches.size > 1, "Expected multiple batches, got ${batches.size}")
    // Verify all events are present across all batches
    val allEvents = batches.flatMap { json ->
      (SdkEventSerializer.fromJson(json) as? SdkEventBatch)?.events ?: emptyList()
    }
    assertEquals(10, allEvents.size)
  }

  @Test
  fun `single oversized event sent with null applicationId`() {
    // Create a single event and set maxBytes very small to force the oversized path
    val events = listOf(makeEvent("big-event"))
    val batches = SdkEventBroadcaster.splitIntoBatches(events, "com.example", maxBytes = 10)
    assertEquals(1, batches.size)
    // The oversized single-event batch should have null applicationId
    val parsed = SdkEventSerializer.fromJson(batches[0]) as? SdkEventBatch
    assertEquals(null, parsed?.applicationId)
  }

  @Test
  fun `preserves applicationId in normal batches`() {
    val events = listOf(makeEvent("event-1"))
    val batches = SdkEventBroadcaster.splitIntoBatches(events, "com.example.app")
    val parsed = SdkEventSerializer.fromJson(batches[0]) as? SdkEventBatch
    assertEquals("com.example.app", parsed?.applicationId)
  }

  @Test
  fun `recursive split handles odd number of events`() {
    val events = (1..7).map { makeEvent("event-$it") }
    val batches = SdkEventBroadcaster.splitIntoBatches(events, "com.example", maxBytes = 300)
    val allEvents = batches.flatMap { json ->
      (SdkEventSerializer.fromJson(json) as? SdkEventBatch)?.events ?: emptyList()
    }
    assertEquals(7, allEvents.size, "All 7 events should be present")
  }
}
