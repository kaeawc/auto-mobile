package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.random.Random

/** Initial reconnect backoff; doubles per attempt up to [RECONNECT_MAX_DELAY_MS]. */
internal const val RECONNECT_INITIAL_DELAY_MS = 500L

/** Ceiling for the reconnect backoff so a long daemon outage still polls at a steady cadence. */
internal const val RECONNECT_MAX_DELAY_MS = 15_000L

/**
 * Exponential backoff (base [initialMs], doubling per attempt, capped at [maxMs]) for reconnect
 * attempt [attempt] (1-based). Pure and overflow-safe so the delay is deterministic; production
 * adds jitter on top via [jitteredReconnectBackoffMs].
 */
internal fun reconnectBackoffMs(
  attempt: Int,
  initialMs: Long = RECONNECT_INITIAL_DELAY_MS,
  maxMs: Long = RECONNECT_MAX_DELAY_MS,
): Long {
  val n = attempt.coerceAtLeast(1)
  val factor = 1L shl minOf(n - 1, 20)
  // Guard the multiply against overflow before comparing to the cap.
  val exp = if (factor > maxMs / initialMs) maxMs else initialMs * factor
  return minOf(exp, maxMs)
}

/** Upper bound of the random spread added to each reconnect delay, as a fraction of it. */
internal const val RECONNECT_JITTER_FRACTION = 0.2

/**
 * [reconnectBackoffMs] plus up to [RECONNECT_JITTER_FRACTION] of it drawn from [random], so panes
 * that dropped together on a daemon restart do not all reconnect in the same instant. [random] is
 * the determinism seam: a test passes a seeded or fixed source.
 */
internal fun jitteredReconnectBackoffMs(attempt: Int, random: Random = Random.Default): Long {
  val base = reconnectBackoffMs(attempt)
  val spread = (base * RECONNECT_JITTER_FRACTION).toLong()
  return base + if (spread > 0) random.nextLong(spread + 1) else 0L
}
