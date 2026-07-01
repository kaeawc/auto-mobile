package dev.jasonpearson.automobile.sdk

import dev.jasonpearson.automobile.sdk.events.BackPressureStrategy
import dev.jasonpearson.automobile.sdk.events.EventProcessor

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
data class AutoMobileConfiguration
internal constructor(
    val bufferSize: Int,
    val flushIntervalMs: Long,
    /**
     * Maximum breadcrumbs retained in the ring buffer. Consumed by the breadcrumb trail feature
     * (#1698).
     */
    val maxBreadcrumbs: Int,
    /**
     * Background inactivity timeout before a session is rotated, in milliseconds. Consumed by the
     * session tracker (#1695).
     */
    val sessionTimeoutMs: Long,
    /**
     * Event processors invoked in order before an event is buffered. Returning null drops the
     * event.
     */
    val eventProcessors: List<EventProcessor> = emptyList(),
    /** Hard cap on pending events in the buffer. Oldest events are evicted when exceeded. */
    val maxPendingEvents: Int = DEFAULT_MAX_PENDING_EVENTS,
    /** Strategy for handling events when the buffer is full. */
    val backPressureStrategy: BackPressureStrategy = BackPressureStrategy.DROP_OLDEST,
) {

  class Builder {
    private var bufferSize: Int = DEFAULT_BUFFER_SIZE
    private var flushIntervalMs: Long = DEFAULT_FLUSH_INTERVAL_MS
    private var maxBreadcrumbs: Int = DEFAULT_MAX_BREADCRUMBS
    private var sessionTimeoutMs: Long = DEFAULT_SESSION_TIMEOUT_MS
    private var eventProcessors: List<EventProcessor> = emptyList()
    private var maxPendingEvents: Int = DEFAULT_MAX_PENDING_EVENTS
    private var backPressureStrategy: BackPressureStrategy = BackPressureStrategy.DROP_OLDEST

    /** Maximum events before forced flush. Must be > 0. */
    fun bufferSize(value: Int) = apply { this.bufferSize = value }

    /** Periodic flush interval in milliseconds. Must be > 0. */
    fun flushIntervalMs(value: Long) = apply { this.flushIntervalMs = value }

    /** Maximum breadcrumbs in ring buffer. Must be > 0. */
    fun maxBreadcrumbs(value: Int) = apply { this.maxBreadcrumbs = value }

    /** Session background timeout in milliseconds. Must be > 0. */
    fun sessionTimeoutMs(value: Long) = apply { this.sessionTimeoutMs = value }

    /** Event processors invoked before buffering. */
    fun eventProcessors(value: List<EventProcessor>) = apply { this.eventProcessors = value }

    /** Hard cap on pending events in the buffer. Must be > 0. */
    fun maxPendingEvents(value: Int) = apply { this.maxPendingEvents = value }

    /** Strategy for handling events when the buffer is full. */
    fun backPressureStrategy(value: BackPressureStrategy) = apply {
      this.backPressureStrategy = value
    }

    fun build(): AutoMobileConfiguration {
      require(bufferSize > 0) { "bufferSize must be > 0, was $bufferSize" }
      require(flushIntervalMs > 0) { "flushIntervalMs must be > 0, was $flushIntervalMs" }
      require(maxBreadcrumbs > 0) { "maxBreadcrumbs must be > 0, was $maxBreadcrumbs" }
      require(sessionTimeoutMs > 0) { "sessionTimeoutMs must be > 0, was $sessionTimeoutMs" }
      require(maxPendingEvents > 0) { "maxPendingEvents must be > 0, was $maxPendingEvents" }

      return AutoMobileConfiguration(
          bufferSize = bufferSize,
          flushIntervalMs = flushIntervalMs,
          maxBreadcrumbs = maxBreadcrumbs,
          sessionTimeoutMs = sessionTimeoutMs,
          eventProcessors = eventProcessors,
          maxPendingEvents = maxPendingEvents,
          backPressureStrategy = backPressureStrategy,
      )
    }
  }

  companion object {
    const val DEFAULT_BUFFER_SIZE = 50
    const val DEFAULT_FLUSH_INTERVAL_MS = 500L
    const val DEFAULT_MAX_BREADCRUMBS = 100
    const val DEFAULT_SESSION_TIMEOUT_MS = 30_000L
    const val DEFAULT_MAX_PENDING_EVENTS = 500
  }
}
