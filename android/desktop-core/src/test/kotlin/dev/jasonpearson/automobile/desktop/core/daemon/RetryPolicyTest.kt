package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.Test

class RetryPolicyTest {

  @Test
  fun succeedsOnFirstAttemptWithoutRetry() {
    var attempts = 0
    val result =
      retryWithBackoffBlocking(RetryPolicy(maxRetries = 3, initialDelayMs = 1)) {
        attempts++
        "ok"
      }
    assertEquals("ok", result)
    assertEquals(1, attempts)
  }

  @Test
  fun retriesUpToMaxRetries() {
    var attempts = 0
    val policy = RetryPolicy(maxRetries = 3, initialDelayMs = 1, jitterFraction = 0.0)
    val ex =
      assertFailsWith<IllegalStateException> {
        retryWithBackoffBlocking(policy) {
          attempts++
          throw IllegalStateException("fail $attempts")
        }
      }
    assertEquals(3, attempts)
    assertEquals("fail 3", ex.message)
  }

  @Test
  fun succeedsAfterTransientFailure() {
    var attempts = 0
    val policy = RetryPolicy(maxRetries = 3, initialDelayMs = 1, jitterFraction = 0.0)
    val result =
      retryWithBackoffBlocking(policy) {
        attempts++
        if (attempts < 2) throw IllegalStateException("transient")
        "recovered"
      }
    assertEquals("recovered", result)
    assertEquals(2, attempts)
  }

  @Test
  fun nonRetryableExceptionSkipsRetry() {
    var attempts = 0
    val policy = RetryPolicy(maxRetries = 3, initialDelayMs = 1)
    assertFailsWith<IllegalArgumentException> {
      retryWithBackoffBlocking(policy, isRetryable = { it !is IllegalArgumentException }) {
        attempts++
        throw IllegalArgumentException("bad input")
      }
    }
    assertEquals(1, attempts)
  }

  @Test
  fun cancellationExceptionPropagatesImmediately() {
    var attempts = 0
    val policy = RetryPolicy(maxRetries = 3, initialDelayMs = 1)
    assertFailsWith<CancellationException> {
      retryWithBackoffBlocking(policy) {
        attempts++
        throw CancellationException("cancelled")
      }
    }
    assertEquals(1, attempts)
  }

  @Test
  fun zeroMaxRetriesExecutesBlockOnce() {
    var attempts = 0
    val result =
      retryWithBackoffBlocking(RetryPolicy(maxRetries = 0, initialDelayMs = 1)) {
        attempts++
        "ok"
      }
    assertEquals("ok", result)
    assertEquals(1, attempts)
  }

  @Test
  fun zeroMaxRetriesThrowsOnFailure() {
    var attempts = 0
    val ex =
      assertFailsWith<IllegalStateException> {
        retryWithBackoffBlocking(RetryPolicy(maxRetries = 0, initialDelayMs = 1)) {
          attempts++
          throw IllegalStateException("fail")
        }
      }
    assertEquals(1, attempts)
    assertEquals("fail", ex.message)
  }

  @Test
  fun zeroRetriesPropagatesOriginalExceptionAfterOneAttempt() {
    val original = IllegalStateException("original failure")
    var attempts = 0
    val thrown =
      assertFailsWith<IllegalStateException> {
        retryWithBackoffBlocking(RetryPolicy(maxRetries = 0, initialDelayMs = 0)) {
          attempts++
          throw original
        }
      }
    assertEquals(1, attempts)
    assertSame(original, thrown)
  }

  @Test
  fun exhaustedRetriesPropagateLastExceptionInstance() {
    val failures = List(3) { IllegalStateException("failure $it") }
    var attempts = 0
    val thrown =
      assertFailsWith<IllegalStateException> {
        retryWithBackoffBlocking(RetryPolicy(maxRetries = failures.size, initialDelayMs = 0)) {
          throw failures[attempts++]
        }
      }
    assertEquals(failures.size, attempts)
    assertSame(failures.last(), thrown)
  }

  @Test
  fun backoffDelayRespectsMaxDelay() {
    val policy =
      RetryPolicy(
        maxRetries = 3,
        initialDelayMs = 10000,
        maxDelayMs = 5,
        backoffMultiplier = 10.0,
        jitterFraction = 0.0,
      )
    var attempts = 0
    val start = System.currentTimeMillis()
    assertFailsWith<RuntimeException> {
      retryWithBackoffBlocking(policy) {
        attempts++
        throw RuntimeException("fail")
      }
    }
    val elapsed = System.currentTimeMillis() - start
    assertEquals(3, attempts)
    // With maxDelayMs=5, 2 sleeps should total at most ~10ms (plus overhead)
    assertTrue(elapsed < 200, "Expected fast execution with capped delay, got ${elapsed}ms")
  }

  @Test
  fun delayBeforeRetryGrowsWithJitterAndStaysUnderTheCap() {
    val policy = RetryPolicy(initialDelayMs = 1_000, maxDelayMs = 5_000, jitterFraction = 0.5)
    val noJitter =
      object : kotlin.random.Random() {
        override fun nextBits(bitCount: Int) = 0
      }
    assertEquals(1_000, policy.delayBeforeRetryMs(0, noJitter))
    assertEquals(2_000, policy.delayBeforeRetryMs(1, noJitter))
    assertEquals(5_000, policy.delayBeforeRetryMs(5, noJitter))
    repeat(50) { assertTrue(policy.delayBeforeRetryMs(1) in 2_000..3_000) }
    assertEquals(5_000, policy.delayBeforeRetryMs(6))
  }
}
