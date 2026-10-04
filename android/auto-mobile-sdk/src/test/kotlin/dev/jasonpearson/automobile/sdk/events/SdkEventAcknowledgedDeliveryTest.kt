package dev.jasonpearson.automobile.sdk.events

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.EventBatchReplay
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
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
    val pending = mutableListOf<Pair<String, List<SdkEvent>>>()
    val removed = mutableListOf<String>()
    var writes = 0

    override fun persist(events: List<SdkEvent>): String {
      val id = "${++writes}"
      pending.add(id to events)
      return id
    }

    override fun loadPending(): List<Pair<String, List<SdkEvent>>> = pending.toList()

    override fun removeBatch(batchId: String) {
      removed.add(batchId)
      pending.removeAll { it.first == batchId }
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
    var response: Int? = null

    override fun send(
      context: Context,
      batchJson: String,
      ordered: Boolean,
      onResult: (Int) -> Unit,
    ) {
      if (!ordered) {
        plainSends++
        return
      }
      this.ordered.add(batchJson)
      results.add(onResult)
      response?.let { respond(results.lastIndex, it) }
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
      onUndelivered = { store.persist(it) },
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
      store.pending.map { (it.second.single() as SdkLifecycleEvent).kind },
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
    val replay = EventBatchReplay()
    val replayed = mutableListOf<String>()
    sender.response = 1000
    send("flush") {
      replay.replay(store, { it.run() }) { events, complete ->
        replayed.add((events.single() as SdkLifecycleEvent).kind)
        SdkEventBroadcaster.broadcastBatch(
          context,
          events,
          onUndelivered = {},
          onFinished = complete,
          splitBatches = false,
        )
      }
    }
    assertEquals(listOf("oldest", "second"), replayed)
    assertEquals(listOf("1", "2"), store.removed)
    assertEquals(2, store.writes)
    assertTrue(store.pending.isEmpty())
    assertEquals(5, sender.ordered.size)
  }

  @Test
  fun `unacknowledged replay stops retains rest and prevents overlapping passes`() {
    store.persist(listOf(event("first")))
    store.persist(listOf(event("second")))
    val replay = EventBatchReplay()
    val deliver: (List<SdkEvent>, (BatchDeliveryOutcome) -> Unit) -> Unit = { events, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = {},
        onFinished = complete,
        splitBatches = false,
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
    val deliver: (List<SdkEvent>, (BatchDeliveryOutcome) -> Unit) -> Unit = { events, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onUndelivered = {},
        onFinished = complete,
        splitBatches = false,
      )
    }
    replay.replay(store, { it.run() }, deliver)
    assertEquals(listOf("2"), store.pending.map { it.first })
    assertEquals(listOf("1"), store.removed)
    assertEquals(1, sender.ordered.size)
    assertEquals(1L, drops.snapshot()[DropReason.DELIVERY_FAILED])
    sender.response = 1000
    replay.replay(store, { it.run() }, deliver)
    assertTrue(store.pending.isEmpty())
    assertEquals(listOf("1", "2"), store.removed)
    assertEquals(1L, drops.snapshot()[DropReason.DELIVERY_FAILED])
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
    store.pending.add("empty" to emptyList())
    val replay = EventBatchReplay()
    val deliver: (List<SdkEvent>, (BatchDeliveryOutcome) -> Unit) -> Unit = { events, complete ->
      SdkEventBroadcaster.broadcastBatch(
        context,
        events,
        onFinished = complete,
        splitBatches = false,
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
}
