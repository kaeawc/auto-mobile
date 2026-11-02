package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode

/** Session-local windows; checking records nothing so other dispatch gates cannot spend budget. */
internal class PrototypePlatformRateLimiter(private val now: () -> Long) {
  private val timestamps = mutableMapOf<String, MutableList<Long>>()

  @Synchronized
  fun refusal(call: String): PlatformCallResult? {
    val module = call.substringBefore('.')
    val limit = PrototypePlatformCalls.rateLimit(module) ?: return null
    val current = now()
    val cutoff = current - limit.windowMs
    val recent = timestamps.getOrPut(module) { mutableListOf() }
    recent.removeAll { it <= cutoff || it > current }
    if (recent.size < limit.calls) return null
    return PlatformCallResult.Failure(
      PlatformError(
        PlatformErrorCode.TOO_MANY_IN_FLIGHT,
        "Rate limit exceeded for $module: at most ${limit.calls} calls per ${limit.windowMs} ms",
      ),
    )
  }

  /** Called under the host lock after every gate accepts, immediately before queueing the call. */
  @Synchronized
  fun recordAdmission(call: String) {
    val module = call.substringBefore('.')
    if (PrototypePlatformCalls.rateLimit(module) == null) return
    timestamps.getOrPut(module) { mutableListOf() }.add(now())
  }
}
