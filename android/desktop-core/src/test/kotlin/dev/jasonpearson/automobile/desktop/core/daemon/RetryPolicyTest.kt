package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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
}
