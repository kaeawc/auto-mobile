package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BroadcastThrottlerTest {

  private class FakeTimeProvider(var nowMs: Long = 0L) : TimeProvider {
    override fun currentTimeMillis(): Long = nowMs
  }

  @Test
  fun `first call always broadcasts`() {
    val time = FakeTimeProvider(1000L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    assertTrue(throttler.shouldBroadcast())
  }

  @Test
  fun `subsequent call within interval is throttled`() {
    val time = FakeTimeProvider(1000L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    assertTrue(throttler.shouldBroadcast())

    time.nowMs = 1100L
    assertFalse(throttler.shouldBroadcast())
  }

  @Test
  fun `call after interval elapses broadcasts`() {
    val time = FakeTimeProvider(1000L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    assertTrue(throttler.shouldBroadcast())

    time.nowMs = 1250L
    assertTrue(throttler.shouldBroadcast())
  }

  @Test
  fun `call exactly at interval boundary broadcasts`() {
    val time = FakeTimeProvider(1000L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    assertTrue(throttler.shouldBroadcast())

    time.nowMs = 1250L
    assertTrue(throttler.shouldBroadcast())
  }

  @Test
  fun `multiple throttled calls followed by elapsed interval`() {
    val time = FakeTimeProvider(0L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    assertTrue(throttler.shouldBroadcast())

    time.nowMs = 50L
    assertFalse(throttler.shouldBroadcast())

    time.nowMs = 100L
    assertFalse(throttler.shouldBroadcast())

    time.nowMs = 249L
    assertFalse(throttler.shouldBroadcast())

    time.nowMs = 250L
    assertTrue(throttler.shouldBroadcast())
  }

  @Test
  fun `timeSinceLastBroadcastMs reports elapsed time`() {
    val time = FakeTimeProvider(1000L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    throttler.shouldBroadcast()

    time.nowMs = 1150L
    assertTrue(throttler.timeSinceLastBroadcastMs() == 150L)
  }

  @Test
  fun `updated interval controls subsequent broadcasts`() {
    val time = FakeTimeProvider(1000L)
    val throttler = BroadcastThrottler(time, minIntervalMs = 250L)

    assertTrue(throttler.shouldBroadcast())

    throttler.setMinIntervalMs(500L)
    time.nowMs = 1300L
    assertFalse(throttler.shouldBroadcast())

    time.nowMs = 1500L
    assertTrue(throttler.shouldBroadcast())
  }
}
