package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.RECONNECT_JITTER_FRACTION
import dev.jasonpearson.automobile.desktop.core.daemon.jitteredReconnectBackoffMs
import dev.jasonpearson.automobile.desktop.core.daemon.reconnectBackoffMs
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectBackoffJitterTest {
  /** A Random whose every draw is a fixed fraction of the requested bound. */
  private class FractionRandom(private val fraction: Double) : Random() {
    override fun nextBits(bitCount: Int): Int = 0

    override fun nextLong(until: Long): Long = ((until - 1) * fraction).toLong()
  }

  @Test
  fun `jitter adds at most the configured fraction on top of the exponential base`() {
    (1..8).forEach { attempt ->
      val base = reconnectBackoffMs(attempt)
      val spread = (base * RECONNECT_JITTER_FRACTION).toLong()
      assertEquals(base, jitteredReconnectBackoffMs(attempt, FractionRandom(0.0)))
      assertEquals(base + spread, jitteredReconnectBackoffMs(attempt, FractionRandom(1.0)))
    }
  }

  @Test
  fun `seeded jitter is deterministic and spreads lockstep reconnects`() {
    val delays = (1..20).map { seed -> jitteredReconnectBackoffMs(3, Random(seed)) }
    assertEquals(delays, (1..20).map { seed -> jitteredReconnectBackoffMs(3, Random(seed)) })
    assertTrue(delays.all { it in reconnectBackoffMs(3)..(reconnectBackoffMs(3) * 6 / 5) })
    assertNotEquals(1, delays.toSet().size)
  }
}
