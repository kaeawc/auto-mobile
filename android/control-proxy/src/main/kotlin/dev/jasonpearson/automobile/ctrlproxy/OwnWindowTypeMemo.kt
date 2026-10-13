package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo

/** Memoises accessibility window types by window id. Thread-safe. */
internal class OwnWindowTypeMemo(
  private val nowMs: () -> Long,
  private val unresolvedRetryMs: Long = 250,
  private val resolvedTtlMs: Long = 5_000,
  private val maxEntries: Int = 32,
) {
  private data class Entry(val type: Int?, val atMs: Long)

  private val entries = mutableMapOf<Int, Entry>()

  init {
    require(maxEntries > 0) { "maxEntries must be positive" }
  }

  /** Window type for [windowId]; calls [resolve] (the binder work) only on a miss/expiry. */
  @Synchronized
  fun windowType(windowId: Int, resolve: () -> Int?): Int? {
    if (windowId < 0) return null
    val now = nowMs()
    val entry = entries[windowId]
    if (entry != null) {
      val ttlMs = if (entry.type == null) unresolvedRetryMs else resolvedTtlMs
      if (now >= entry.atMs && now - entry.atMs < ttlMs) return entry.type
    }
    val type = resolve()
    // Clear before inserting a new id so the hard cap is never exceeded, even transiently.
    if (entry == null && entries.size >= maxEntries) entries.clear()
    entries[windowId] = Entry(type, now)
    return type
  }

  @Synchronized
  fun clear() {
    entries.clear()
  }
}

/** What the own-window filter decided for one event. */
internal data class OwnWindowEventDecision(val skip: Boolean, val windowType: Int?)

internal fun ownWindowEventDecision(
  eventPackage: String?,
  ownPackage: String,
  windowId: Int,
  memo: OwnWindowTypeMemo,
  appLayerShowing: () -> Boolean,
  resolve: () -> Int?,
): OwnWindowEventDecision {
  if (eventPackage != ownPackage) return OwnWindowEventDecision(false, null)
  val type = memo.windowType(windowId, resolve)
  val showing = type == AccessibilityWindowInfo.TYPE_SYSTEM && appLayerShowing()
  return OwnWindowEventDecision(
    shouldSkipOwnWindowEvent(eventPackage, ownPackage, type, showing),
    type,
  )
}

/**
 * True when a windows-changed event can make a memoised id stale. [windowChanges] null = unknown
 * (pre-API 28).
 */
internal fun invalidatesOwnWindowTypes(eventType: Int, windowChanges: Int?): Boolean {
  if (eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED) return false
  val invalidatingChanges =
    AccessibilityEvent.WINDOWS_CHANGE_ADDED or AccessibilityEvent.WINDOWS_CHANGE_REMOVED
  return windowChanges == null || windowChanges and invalidatingChanges != 0
}
