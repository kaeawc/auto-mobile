package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.TimeUnit

/**
 * How [McpStdioClient] throttles restarts of a server that keeps dying right after it starts.
 *
 * A child that exits within [healthyUptimeMs] of starting is a "quick exit". After [maxQuickExits]
 * of them in a row the client stops starting it for [coolDownMs]; each further quick exit after a
 * cool-down doubles the wait, up to [maxCoolDownMs]. A child that lived at least [healthyUptimeMs]
 * before it exited clears the count, so one crash of a long-running server restarts immediately.
 */
data class StdioRestartPolicy(
  val maxQuickExits: Int = 3,
  val healthyUptimeMs: Long = 10_000,
  val coolDownMs: Long = 10_000,
  val maxCoolDownMs: Long = 120_000,
)

/**
 * Bookkeeping for [StdioRestartPolicy] on an injected clock. Not thread safe: [McpStdioClient]
 * calls it only while holding its I/O lock.
 */
internal class StdioRestartGuard(
  private val policy: StdioRestartPolicy,
  private val nowNanos: () -> Long,
) {
  private var quickExits = 0
  private var blockedUntilNanos = 0L

  /** Consecutive quick exits so far (0 after a healthy exit). */
  val consecutiveQuickExits: Int
    get() = quickExits

  /** Records that a child which started at [startedAtNanos] (null: it never started) exited. */
  fun recordExit(startedAtNanos: Long?) {
    val now = nowNanos()
    val lived = startedAtNanos?.let { now - it }
    val healthy = lived != null && lived >= TimeUnit.MILLISECONDS.toNanos(policy.healthyUptimeMs)
    if (healthy) {
      quickExits = 0
      blockedUntilNanos = 0L
      return
    }
    quickExits++
    if (quickExits >= policy.maxQuickExits) {
      val doublings = (quickExits - policy.maxQuickExits).coerceAtMost(MAX_DOUBLINGS)
      val waitMs = (policy.coolDownMs shl doublings).coerceAtMost(policy.maxCoolDownMs)
      blockedUntilNanos = now + TimeUnit.MILLISECONDS.toNanos(waitMs)
    }
  }

  /** Milliseconds until another start is allowed; 0 when one is allowed now. */
  fun remainingCoolDownMs(): Long {
    if (quickExits < policy.maxQuickExits) {
      return 0L
    }
    val remaining = blockedUntilNanos - nowNanos()
    return if (remaining <= 0) 0L else TimeUnit.NANOSECONDS.toMillis(remaining).coerceAtLeast(1)
  }

  private companion object {
    const val MAX_DOUBLINGS = 10
  }
}
