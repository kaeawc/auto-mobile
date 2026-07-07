package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider

class BroadcastThrottler(
  private val timeProvider: TimeProvider,
  private var minIntervalMs: Long,
) {
  private var lastBroadcastMs: Long? = null

  fun shouldBroadcast(): Boolean {
    val now = timeProvider.currentTimeMillis()
    val last = lastBroadcastMs
    if (last == null || now - last >= minIntervalMs) {
      lastBroadcastMs = now
      return true
    }
    return false
  }

  fun timeSinceLastBroadcastMs(): Long {
    val last = lastBroadcastMs ?: return 0L
    return timeProvider.currentTimeMillis() - last
  }

  fun setMinIntervalMs(intervalMs: Long) {
    minIntervalMs = intervalMs
  }
}
