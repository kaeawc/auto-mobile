package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.protocol.PrototypeRateLimit
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypePlatformRateLimiterTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      // Load the contract outside measured fake-clock tests.
      PrototypePlatformCalls.rateLimit("share")
    }
  }

  private val shareRefusal =
    PlatformCallResult.Failure(
      PlatformError(
        PlatformErrorCode.TOO_MANY_IN_FLIGHT,
        "Rate limit exceeded for share: at most 5 calls per 10000 ms",
      ),
    )

  private fun admit(limiter: PrototypePlatformRateLimiter, call: String): PlatformCallResult? {
    val refusal = limiter.refusal(call)
    if (refusal == null) limiter.recordAdmission(call)
    return refusal
  }

  @Test
  fun `contract exposes positive module rate limits`() {
    assertEquals(PrototypeRateLimit(5, 10000), PrototypePlatformCalls.rateLimit("share"))
    assertEquals(PrototypeRateLimit(10, 60000), PrototypePlatformCalls.rateLimit("notifications"))
    assertNull(PrototypePlatformCalls.rateLimit("clipboard"))
    assertNull(PrototypePlatformCalls.rateLimit("unknown"))
  }

  @Test
  fun `share allows five calls and refuses the sixth`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    assertEquals(shareRefusal, admit(limiter, "share.open"))
  }

  @Test
  fun `window expires at the exact boundary`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    advanceTimeBy(9999)
    assertEquals(shareRefusal, admit(limiter, "share.open"))
    advanceTimeBy(1)
    assertNull(admit(limiter, "share.open"))
  }

  @Test
  fun `sliding window retains later admissions`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    assertNull(admit(limiter, "share.open"))
    advanceTimeBy(5000)
    repeat(4) { assertNull(admit(limiter, "share.open")) }
    advanceTimeBy(5000)
    assertNull(admit(limiter, "share.open"))
    assertEquals(shareRefusal, admit(limiter, "share.open"))
    advanceTimeBy(5000)
    repeat(4) { assertNull(admit(limiter, "share.open")) }
    assertEquals(shareRefusal, admit(limiter, "share.open"))
  }

  @Test
  fun `refused calls do not consume budget`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    advanceTimeBy(9999)
    repeat(3) { assertEquals(shareRefusal, admit(limiter, "share.open")) }
    advanceTimeBy(1)
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    assertEquals(shareRefusal, admit(limiter, "share.open"))
  }

  @Test
  fun `checking without recording does not consume budget`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    repeat(10) { assertNull(limiter.refusal("share.open")) }
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    assertEquals(shareRefusal, limiter.refusal("share.open"))
  }

  @Test
  fun `module budgets are independent and clipboard is unlimited`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    assertEquals(shareRefusal, admit(limiter, "share.open"))
    repeat(10) { assertNull(admit(limiter, "notifications.post")) }
    repeat(100) {
      assertNull(admit(limiter, "clipboard.copy"))
      assertNull(admit(limiter, "clipboard.paste"))
    }
  }

  @Test
  fun `notifications share ten calls per minute across call names`() = runTest {
    val limiter = PrototypePlatformRateLimiter { testScheduler.currentTime }
    repeat(5) {
      assertNull(admit(limiter, "notifications.post"))
      assertNull(admit(limiter, "notifications.schedule"))
    }
    val refusal =
      PlatformCallResult.Failure(
        PlatformError(
          PlatformErrorCode.TOO_MANY_IN_FLIGHT,
          "Rate limit exceeded for notifications: at most 10 calls per 60000 ms",
        ),
      )
    assertEquals(refusal, admit(limiter, "notifications.setBadge"))
    advanceTimeBy(59999)
    assertEquals(refusal, admit(limiter, "notifications.post"))
    advanceTimeBy(1)
    repeat(10) { assertNull(admit(limiter, "notifications.setBadge")) }
    assertEquals(refusal, admit(limiter, "notifications.post"))
  }

  @Test
  fun `timestamps later than now do not count`() {
    var now = 100L
    val limiter = PrototypePlatformRateLimiter { now }
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    now = 99L
    repeat(5) { assertNull(admit(limiter, "share.open")) }
    assertEquals(shareRefusal, admit(limiter, "share.open"))
  }
}
