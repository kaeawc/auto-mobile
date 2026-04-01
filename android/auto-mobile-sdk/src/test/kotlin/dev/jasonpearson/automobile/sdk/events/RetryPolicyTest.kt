package dev.jasonpearson.automobile.sdk.events

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

class RetryPolicyTest {

  @Test
  fun `default values`() {
    val policy = RetryPolicy()
    assertEquals(3, policy.maxRetries)
    assertEquals(100L, policy.baseDelayMs)
    assertEquals(2000L, policy.maxDelayMs)
  }

  @Test
  fun `delayForAttempt grows exponentially`() {
    val policy = RetryPolicy(baseDelayMs = 100, maxDelayMs = 10_000)
    // attempt 0: base * 2^0 = 100 + jitter(0..25)
    val d0 = policy.delayForAttempt(0)
    assertTrue(d0 in 100..125, "attempt 0 delay=$d0 should be in [100,125]")

    // attempt 1: base * 2^1 = 200 + jitter(0..50)
    val d1 = policy.delayForAttempt(1)
    assertTrue(d1 in 200..250, "attempt 1 delay=$d1 should be in [200,250]")

    // attempt 2: base * 2^2 = 400 + jitter(0..100)
    val d2 = policy.delayForAttempt(2)
    assertTrue(d2 in 400..500, "attempt 2 delay=$d2 should be in [400,500]")
  }

  @Test
  fun `delayForAttempt is clamped to maxDelayMs`() {
    val policy = RetryPolicy(baseDelayMs = 100, maxDelayMs = 300)
    // attempt 2: 100 * 4 = 400 → clamped to 300 + jitter(0..75)
    val d2 = policy.delayForAttempt(2)
    assertTrue(d2 in 300..375, "attempt 2 delay=$d2 should be clamped to [300,375]")
  }

  @Test
  fun `negative attempt treated as zero`() {
    val policy = RetryPolicy(baseDelayMs = 100, maxDelayMs = 2000)
    val d = policy.delayForAttempt(-1)
    assertTrue(d in 100..125, "negative attempt delay=$d should behave like attempt 0")
  }

  @Test
  fun `very large attempt does not overflow`() {
    val policy = RetryPolicy(baseDelayMs = 100, maxDelayMs = 2000)
    // attempt 50 → clamped to 30, so 100 * 2^30 → clamped to 2000
    val d = policy.delayForAttempt(50)
    assertTrue(d in 2000..2500, "large attempt delay=$d should be clamped")
  }
}
