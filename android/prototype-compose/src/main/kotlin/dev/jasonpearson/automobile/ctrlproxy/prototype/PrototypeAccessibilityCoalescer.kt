package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityEvent

/** Leading and trailing subtree invalidations, driven on the view thread. */
@InternalAutoMobilePrototypeApi
class PrototypeAccessibilityCoalescer(
  private val nowMs: () -> Long,
  private val intervalMs: Long = 250,
) {
  enum class Action {
    EMIT_NOW,
    SCHEDULE_TRAILING,
    NONE,
  }

  private var lastEmitMs: Long? = null
  private var trailingPending = false

  fun onCoalescible(): Action {
    // Preserve the trailing invalidation even if its callback runs late.
    if (trailingPending) return Action.NONE
    val now = nowMs()
    val lastEmit = lastEmitMs
    if (lastEmit == null || now - lastEmit >= intervalMs) {
      lastEmitMs = now
      return Action.EMIT_NOW
    }
    trailingPending = true
    return Action.SCHEDULE_TRAILING
  }

  fun onTrailingFired() {
    trailingPending = false
    lastEmitMs = nowMs()
  }

  fun reset() {
    lastEmitMs = null
    trailingPending = false
  }

  fun remainingMs(): Long {
    val lastEmit = lastEmitMs ?: return 0
    return (intervalMs - (nowMs() - lastEmit)).coerceAtLeast(0)
  }
}

@InternalAutoMobilePrototypeApi
fun isCoalescibleAccessibilityEvent(eventType: Int, contentChangeTypes: Int): Boolean =
  eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED ||
    (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED &&
      contentChangeTypes and AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE.inv() == 0)
