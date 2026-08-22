package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.NavigationEvent
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/**
 * Data class representing a navigation event with timestamp. Serializable for WebSocket
 * transmission.
 */
@Serializable
data class TimestampedNavigationEvent(
  val destination: String,
  val source: String,
  val arguments: Map<String, String>,
  val metadata: Map<String, String>,
  val timestamp: Long, // System.currentTimeMillis()
  val sequenceNumber: Long, // Monotonically increasing sequence number
  val applicationId: String? = null, // Package name of the app that generated this event
)

/**
 * Accumulates navigation events from AutoMobileSDK and provides them for WebSocket broadcast.
 *
 * This class:
 * - Registers as a listener to AutoMobileSDK navigation events
 * - Stores events with precise timestamps
 * - Maintains a circular buffer of recent events (last 100)
 * - Emits events via StateFlow for reactive consumption
 * - Provides accumulated events since a given timestamp
 */
class NavigationEventAccumulator {
  // ArrayDeque ring buffer: O(1) append (addLast) + evict (removeFirst), no
  // per-event array copy. Every access is guarded by bufferLock (#5464).
  private val events = ArrayDeque<TimestampedNavigationEvent>()
  // Incremented from two paths (addEvent + the navigation listener callback);
  // AtomicLong so concurrent events can't collide on a sequence number (#3604).
  private val sequenceNumber = AtomicLong(0L)
  private val maxEvents = 100 // Keep last 100 events

  // Guards every read/write of the non-thread-safe ArrayDeque so the buffer
  // can't be trimmed mid-read (IndexOutOfBoundsException, #3604) and reads
  // return a consistent point-in-time snapshot.
  private val bufferLock = Any()

  // StateFlow for reactive consumption - emits latest event
  private val _latestEvent = MutableStateFlow<TimestampedNavigationEvent?>(null)
  val latestEvent: StateFlow<TimestampedNavigationEvent?> = _latestEvent.asStateFlow()

  // StateFlow for event count - useful for detecting changes
  private val _eventCount = MutableStateFlow(0)
  val eventCount: StateFlow<Int> = _eventCount.asStateFlow()

  /** Initialize and register navigation listener with AutoMobileSDK. */
  fun initialize() {
    AutoMobileSDK.addNavigationListener { event -> onNavigationEvent(event) }
  }

  /** Manually add a navigation event from external sources (e.g., broadcasts). */
  fun addEvent(
    destination: String,
    source: String,
    arguments: Map<String, String>,
    metadata: Map<String, String>,
    applicationId: String? = null,
    timestamp: Long = System.currentTimeMillis(),
    publishLatestEvent: Boolean = true,
  ): TimestampedNavigationEvent {
    val sequence = sequenceNumber.getAndIncrement()

    val timestampedEvent =
      TimestampedNavigationEvent(
        destination = destination,
        source = source,
        arguments = arguments,
        metadata = metadata,
        timestamp = timestamp,
        sequenceNumber = sequence,
        applicationId = applicationId,
      )

    appendEvent(timestampedEvent, publishLatestEvent)
    return timestampedEvent
  }

  /**
   * Records a navigation event emitted by the SDK's batched cross-process protocol.
   *
   * CtrlProxy forwards the returned event sequentially because [latestEvent] is intentionally
   * conflating and cannot preserve every event in one batch.
   */
  fun addSdkNavigationEvent(event: SdkNavigationEvent): TimestampedNavigationEvent =
    addEvent(
      destination = event.destination,
      source = event.source.name,
      arguments = event.arguments ?: emptyMap(),
      metadata = event.metadata ?: emptyMap(),
      applicationId = event.applicationId,
      timestamp = event.timestamp,
      publishLatestEvent = false,
    )

  /** Handle incoming navigation event from AutoMobileSDK. */
  private fun onNavigationEvent(event: NavigationEvent) {
    val timestamp = System.currentTimeMillis()
    val sequence = sequenceNumber.getAndIncrement()

    // Convert NavigationEvent to TimestampedNavigationEvent
    // Convert arguments map to String-keyed map (serialize non-string values)
    val stringArguments =
      event.arguments.mapValues { (_, value) ->
        when (value) {
          null -> "null"
          is String -> value
          is Number -> value.toString()
          is Boolean -> value.toString()
          else -> value.toString()
        }
      }

    val timestampedEvent =
      TimestampedNavigationEvent(
        destination = event.destination,
        source = event.source.name,
        arguments = stringArguments,
        metadata = event.metadata,
        timestamp = timestamp,
        sequenceNumber = sequence,
      )

    appendEvent(timestampedEvent)
  }

  /** Append an event and trim the circular buffer atomically, then emit updates. */
  private fun appendEvent(event: TimestampedNavigationEvent, publishLatestEvent: Boolean = true) {
    val size =
      synchronized(bufferLock) {
        events.addLast(event)
        if (events.size > maxEvents) {
          events.removeFirst()
        }
        events.size
      }
    if (publishLatestEvent) {
      _latestEvent.value = event
    }
    _eventCount.value = size
  }

  /** Get all accumulated events. */
  fun getAllEvents(): List<TimestampedNavigationEvent> {
    synchronized(bufferLock) {
      return events.toList()
    }
  }

  /** Get events since a given timestamp (inclusive). */
  fun getEventsSince(sinceTimestamp: Long): List<TimestampedNavigationEvent> {
    synchronized(bufferLock) {
      return events.filter { it.timestamp >= sinceTimestamp }
    }
  }

  /** Get events since a given sequence number (exclusive). */
  fun getEventsSinceSequence(sinceSequence: Long): List<TimestampedNavigationEvent> {
    synchronized(bufferLock) {
      return events.filter { it.sequenceNumber > sinceSequence }
    }
  }

  /** Get the most recent N events. */
  fun getRecentEvents(count: Int): List<TimestampedNavigationEvent> {
    synchronized(bufferLock) {
      val size = events.size
      return if (size <= count) {
        events.toList()
      } else {
        events.subList(size - count, size).toList()
      }
    }
  }

  /** Clear all accumulated events. */
  fun clear() {
    synchronized(bufferLock) { events.clear() }
    _latestEvent.value = null
    _eventCount.value = 0
  }

  /** Get current statistics. */
  fun getStats(): NavigationStats {
    val (totalEvents, oldestTimestamp, newestTimestamp) =
      synchronized(bufferLock) {
        Triple(events.size, events.firstOrNull()?.timestamp, events.lastOrNull()?.timestamp)
      }
    return NavigationStats(
      totalEvents = totalEvents,
      oldestTimestamp = oldestTimestamp,
      newestTimestamp = newestTimestamp,
      currentSequence = sequenceNumber.get(),
    )
  }
}

@Serializable
data class NavigationStats(
  val totalEvents: Int,
  val oldestTimestamp: Long?,
  val newestTimestamp: Long?,
  val currentSequence: Long,
)
