package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.persistence.EventBatchReplay
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventAcknowledgedChunkTest : SdkEventAcknowledgedDeliveryFixture() {
  @Test
  fun `second chunk send exception with exhausted retries retains only that chunk`() {
    assertContainedSendFailure(failedChunk = 2, requireAck = true)
  }

  @Test
  fun `first chunk send exception with exhausted retries retains only that chunk`() {
    assertContainedSendFailure(failedChunk = 1, requireAck = true)
  }

  @Test
  fun `gate off second chunk send exception retains only that chunk`() {
    assertContainedSendFailure(failedChunk = 2, requireAck = false)
  }

  @Test
  fun `gate off first chunk send exception retains only that chunk`() {
    assertContainedSendFailure(failedChunk = 1, requireAck = false)
  }

  @Test
  fun `second chunk send and cancellation exceptions retain only unsent chunks with stable ids`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    val events = (1..3).map { event("chunk-$it-" + "x".repeat(60_000)) }
    var allocations = 0
    SdkEventBroadcaster.batchIdProvider = { "id-${++allocations}" }
    sender.throwForBatchId = "id-2"
    executor.failCancellationAt = 2
    try {
      events.forEach(buffer::add)
      buffer.flush()
      assertEquals(listOf<String?>("id-1", "id-2"), sender.attemptedBatchIds)
      assertEquals(listOf<String?>("id-1"), sender.batchIds)
      assertEquals(0, store.writes, "Persistence must stay queued off the flush caller")
      // The submitted prefix can still acknowledge after the suffix's flush failure.
      sender.respond(0, 1000)
      executor.drain()
      assertEquals(listOf<String?>("id-2", "id-3"), store.pending.map { it.deliveryId })
      assertEquals(listOf(listOf(events[1]), listOf(events[2])), store.pending.map { it.events })
      assertEquals(2L, drops.snapshot()[DropReason.FLUSH_ERROR])
      executor.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
      assertEquals(2, store.writes, "Earlier ack and aborted timeout must not persist again")
      sender.throwForBatchId = null
      sender.response = 1000
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
      assertEquals(3, allocations, "Replay must reuse stored identities")
      assertTrue(store.pending.isEmpty())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `first chunk send and cancellation exceptions preserve whole flush fallback`() {
    val executor = FakeBufferExecutor()
    val buffer = realBuffer(executor)
    val events = (1..3).map { event("chunk-$it-" + "x".repeat(60_000)) }
    var allocations = 0
    SdkEventBroadcaster.batchIdProvider = { "id-${++allocations}" }
    sender.throwForBatchId = "id-1"
    executor.failCancellationAt = 1
    try {
      events.forEach(buffer::add)
      buffer.flush()
      assertEquals(listOf<String?>("id-1"), sender.attemptedBatchIds)
      assertTrue(sender.batchIds.isEmpty())
      assertEquals(0, store.writes)
      executor.drain()
      assertEquals(events, store.pending.single().events)
      assertEquals(null, store.pending.single().deliveryId)
      assertEquals(3L, drops.snapshot()[DropReason.FLUSH_ERROR])
      executor.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
      assertEquals(1, store.writes)
    } finally {
      buffer.shutdown()
    }
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
}
