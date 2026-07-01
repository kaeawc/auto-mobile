package dev.jasonpearson.automobile.sdk.events

/**
 * Configures exponential backoff with jitter for retrying failed event delivery.
 *
 * @param maxRetries Maximum number of retry attempts (default 3)
 * @param baseDelayMs Base delay in milliseconds before first retry (default 100)
 * @param maxDelayMs Upper bound on computed delay (default 2000)
 */
internal data class RetryPolicy(
    val maxRetries: Int = 3,
    val baseDelayMs: Long = 100,
    val maxDelayMs: Long = 2000,
) {
  /**
   * Compute the delay for a given retry attempt (0-indexed).
   *
   * Uses exponential backoff (`baseDelayMs * 2^attempt`) clamped to [maxDelayMs], plus random
   * jitter of up to 25% of the clamped delay.
   */
  fun delayForAttempt(attempt: Int): Long {
    val clamped = attempt.coerceIn(0, 30)
    val delay = (baseDelayMs * (1L shl clamped)).coerceAtMost(maxDelayMs)
    val jitter = if (delay > 0) (0..delay / 4).random() else 0L
    return delay + jitter
  }
}
