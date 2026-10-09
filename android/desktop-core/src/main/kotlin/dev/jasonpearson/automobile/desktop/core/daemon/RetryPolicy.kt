package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

data class RetryPolicy(
  val maxRetries: Int = 3,
  val initialDelayMs: Long = 1000,
  val maxDelayMs: Long = 30000,
  val backoffMultiplier: Double = 2.0,
  val jitterFraction: Double = 0.1,
)

/**
 * The delay before retry number [retry] (0-based): exponential from [RetryPolicy.initialDelayMs],
 * plus up to [RetryPolicy.jitterFraction] of jitter, never above [RetryPolicy.maxDelayMs].
 */
fun RetryPolicy.delayBeforeRetryMs(retry: Int, random: Random = Random.Default): Long {
  val baseDelay = initialDelayMs * backoffMultiplier.pow(retry.toDouble())
  val jitter = baseDelay * jitterFraction * random.nextDouble()
  return min(baseDelay.toLong() + jitter.toLong(), maxDelayMs)
}

/**
 * Retry with exponential backoff (blocking). Suitable for use from non-suspend contexts such as the
 * synchronous McpHttpClient methods.
 */
fun <T> retryWithBackoffBlocking(
  policy: RetryPolicy = RetryPolicy(),
  isRetryable: (Exception) -> Boolean = { true },
  block: () -> T,
): T {
  var attempt = 0
  val attempts = maxOf(1, policy.maxRetries)
  while (true) {
    try {
      return block()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      if (!isRetryable(e) || attempt == attempts - 1) throw e
      Thread.sleep(policy.delayBeforeRetryMs(attempt))
      attempt++
    }
  }
}
