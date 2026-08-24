package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.concurrent.TimeUnit

/** One end-to-end hang budget for a passive daemon status probe. */
class StatusRequestDeadline(
  private val timeoutMs: Long,
  private val nowNanos: () -> Long = System::nanoTime,
) {
  private val deadlineNanos = nowNanos() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)

  fun remainingTimeoutMs(): Long {
    val remainingNanos = deadlineNanos - nowNanos()
    if (remainingNanos <= 0) {
      throw McpConnectionException("MCP status request timed out after ${timeoutMs}ms")
    }
    return TimeUnit.NANOSECONDS.toMillis(remainingNanos).coerceAtLeast(1)
  }
}
