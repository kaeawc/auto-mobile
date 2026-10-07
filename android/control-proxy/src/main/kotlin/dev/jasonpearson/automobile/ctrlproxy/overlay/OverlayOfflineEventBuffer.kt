package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayEvent

/** Most events a device-persistent overlay keeps for a host that is not connected (#10494). */
const val OVERLAY_OFFLINE_EVENT_CAPACITY = 200

/**
 * Bounded ring of overlay events produced while no host was connected. Overflow drops the oldest
 * event and counts it; the sequence gap tells the host how many it missed. Not thread-safe: the
 * controller touches it only under its mutex.
 */
class OverlayOfflineEventBuffer(private val capacity: Int = OVERLAY_OFFLINE_EVENT_CAPACITY) {
  private val events = ArrayDeque<OverlayEvent>()

  init {
    require(capacity > 0) { "capacity must be positive" }
  }

  /** Cumulative events dropped by overflow; never reset, so a later inspect still reports them. */
  var dropped: Long = 0
    private set

  val size: Int
    get() = events.size

  fun add(event: OverlayEvent) {
    if (events.size == capacity) {
      events.removeFirst()
      dropped++
    }
    events.addLast(event)
  }

  /** Removes and returns the buffered events, oldest first. */
  fun drain(): List<OverlayEvent> = events.toList().also { events.clear() }
}
