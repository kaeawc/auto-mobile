package dev.jasonpearson.automobile.sdk

/**
 * Configuration for the AutoMobile SDK.
 *
 * Use [Builder] to construct an instance with custom values:
 * ```kotlin
 * val config = AutoMobileConfiguration.Builder()
 *     .bufferSize(100)
 *     .flushIntervalMs(1000)
 *     .build()
 * ```
 */
@ConsistentCopyVisibility
data class AutoMobileConfiguration internal constructor(
  val bufferSize: Int,
  val flushIntervalMs: Long,
  /** Maximum breadcrumbs retained in the ring buffer. Consumed by the breadcrumb trail feature (#1698). */
  val maxBreadcrumbs: Int,
  /** Background inactivity timeout before a session is rotated, in milliseconds. Consumed by the session tracker (#1695). */
  val sessionTimeoutMs: Long,
) {

  class Builder {
    private var bufferSize: Int = DEFAULT_BUFFER_SIZE
    private var flushIntervalMs: Long = DEFAULT_FLUSH_INTERVAL_MS
    private var maxBreadcrumbs: Int = DEFAULT_MAX_BREADCRUMBS
    private var sessionTimeoutMs: Long = DEFAULT_SESSION_TIMEOUT_MS

    /** Maximum events before forced flush. Must be > 0. */
    fun bufferSize(value: Int) = apply { this.bufferSize = value }

    /** Periodic flush interval in milliseconds. Must be > 0. */
    fun flushIntervalMs(value: Long) = apply { this.flushIntervalMs = value }

    /** Maximum breadcrumbs in ring buffer. Must be > 0. */
    fun maxBreadcrumbs(value: Int) = apply { this.maxBreadcrumbs = value }

    /** Session background timeout in milliseconds. Must be > 0. */
    fun sessionTimeoutMs(value: Long) = apply { this.sessionTimeoutMs = value }

    fun build(): AutoMobileConfiguration {
      require(bufferSize > 0) { "bufferSize must be > 0, was $bufferSize" }
      require(flushIntervalMs > 0) { "flushIntervalMs must be > 0, was $flushIntervalMs" }
      require(maxBreadcrumbs > 0) { "maxBreadcrumbs must be > 0, was $maxBreadcrumbs" }
      require(sessionTimeoutMs > 0) { "sessionTimeoutMs must be > 0, was $sessionTimeoutMs" }

      return AutoMobileConfiguration(
        bufferSize = bufferSize,
        flushIntervalMs = flushIntervalMs,
        maxBreadcrumbs = maxBreadcrumbs,
        sessionTimeoutMs = sessionTimeoutMs,
      )
    }
  }

  companion object {
    const val DEFAULT_BUFFER_SIZE = 50
    const val DEFAULT_FLUSH_INTERVAL_MS = 500L
    const val DEFAULT_MAX_BREADCRUMBS = 100
    const val DEFAULT_SESSION_TIMEOUT_MS = 30_000L
  }
}
