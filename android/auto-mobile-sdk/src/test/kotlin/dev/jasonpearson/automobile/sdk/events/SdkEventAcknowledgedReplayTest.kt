package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.EventBatchReplay
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventAcknowledgedReplayTest : SdkEventAcknowledgedDeliveryFixture() {
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
}
