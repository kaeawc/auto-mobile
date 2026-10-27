package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo

// AccessibilityEvent constants introduced in API 28; these values were already inlined.
private const val WINDOW_CHANGE_ADDED = 1 // WINDOWS_CHANGE_ADDED.
private const val WINDOW_CHANGE_REMOVED = 2 // WINDOWS_CHANGE_REMOVED.

/**
 * Memoises accessibility window types by window id. Thread-safe. The own-window filter does no memo
 * or prototype-state work for foreign packages. Prototype foreground tracking also memoises foreign
 * application windows' types, using positive entries only.
 */
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

  /**
   * Window type for [windowId]; calls [resolve] (the binder work) on a miss/expiry. When
   * [retryUnresolvedImmediately] is true, only positive entries are reused and null is not stored.
   */
  @Synchronized
  fun windowType(
    windowId: Int,
    retryUnresolvedImmediately: Boolean = false,
    resolve: () -> Int?,
  ): Int? {
    if (windowId == UNDEFINED_WINDOW_ID) return null
    val now = nowMs()
    val entry = entries[windowId]
    if (entry != null) {
      val ttlMs = if (entry.type == null) unresolvedRetryMs else resolvedTtlMs
      val canReuseEntry =
        (entry.type != null || !retryUnresolvedImmediately) &&
          now >= entry.atMs &&
          now - entry.atMs < ttlMs
      if (canReuseEntry) {
        return entry.type
      }
    }
    val type = resolve()
    if (type == null && retryUnresolvedImmediately) return null
    // Clear before inserting a new id so the hard cap is never exceeded, even transiently.
    if (entry == null && entries.size >= maxEntries) entries.clear()
    entries[windowId] = Entry(type, now)
    return type
  }

  @Synchronized
  fun clear() {
    entries.clear()
  }

  private companion object {
    const val UNDEFINED_WINDOW_ID = -1
  }
}

/** What the own-window filter decided for one event. */
internal data class OwnWindowEventDecision(val skip: Boolean, val windowType: Int?)

internal fun ownWindowEventDecision(
  event: OwnWindowEvent,
  memo: OwnWindowTypeMemo,
  appLayerShowing: () -> Boolean,
  resolve: () -> Int?,
): OwnWindowEventDecision {
  val eventPackage = event.eventPackage
  val ownPackage = event.ownPackage
  val windowId = event.windowId

  if (eventPackage != ownPackage) return OwnWindowEventDecision(false, null)
  val type = memo.windowType(windowId, resolve = resolve)
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
  val invalidatingChanges = WINDOW_CHANGE_ADDED or WINDOW_CHANGE_REMOVED
  return windowChanges == null || windowChanges and invalidatingChanges != 0
}
