package dev.jasonpearson.automobile.sdk.events

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventAcknowledgedShutdownTest : SdkEventAcknowledgedDeliveryFixture() {
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
