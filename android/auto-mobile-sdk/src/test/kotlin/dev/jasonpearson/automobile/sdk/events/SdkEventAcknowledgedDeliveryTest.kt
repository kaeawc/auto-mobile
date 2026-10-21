package dev.jasonpearson.automobile.sdk.events

import android.content.pm.PackageManager
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventAcknowledgedDeliveryTest : SdkEventAcknowledgedDeliveryFixture() {
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
  fun `timeout followed by invalid result cannot count a retained event as dropped`() {
    send("timeout")
    timer.advance(SdkEventBroadcaster.ACK_TIMEOUT_MS)
    sender.respond(0, 1002)
    assertEquals(1, store.writes)
    assertFalse(store.pending.isEmpty())
    assertTrue(drops.snapshot().isEmpty())
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
}
