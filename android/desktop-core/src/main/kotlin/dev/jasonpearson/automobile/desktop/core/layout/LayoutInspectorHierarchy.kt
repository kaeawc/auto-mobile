package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/** Load mock data for development/testing. */
fun LayoutInspectorState.loadMockData() {
  val root = LayoutInspectorMockData.mockHierarchy
  currentParsedHierarchy = buildParsedHierarchy(root)
  connectionStatus = ConnectionStatus.Connected
  streamingMode = StreamingMode.Paused
}

/**
 * Refresh the hierarchy from the device. Phase 1: Reloads mock data Phase 2: Will request fresh
 * data via WebSocket
 */
fun LayoutInspectorState.refreshHierarchy() {
  // Phase 1: Just reload mock data
  val root = LayoutInspectorMockData.mockHierarchy
  currentParsedHierarchy = buildParsedHierarchy(root)
  lastScreenshotTimestamp = System.currentTimeMillis()
}

/**
 * Compare two element maps to find IDs that are new or have changed properties. Pure function —
 * safe to call off the main thread.
 */
fun LayoutInspectorState.computeChangedElements(
  oldElementMap: Map<String, UIElementInfo>,
  newElementMap: Map<String, UIElementInfo>,
): Set<String> {
  if (oldElementMap.isEmpty()) return emptySet()
  val changedIds = mutableSetOf<String>()
  for ((id, newElement) in newElementMap) {
    val oldElement = oldElementMap[id]
    if (oldElement == null) {
      changedIds.add(id)
    } else if (hasElementChanged(oldElement, newElement)) {
      changedIds.add(id)
    }
  }
  return changedIds
}

/** Check if an element's visible properties have changed. */
internal fun hasElementChanged(old: UIElementInfo, new: UIElementInfo): Boolean {
  return old.text != new.text ||
    old.contentDescription != new.contentDescription ||
    old.bounds != new.bounds ||
    old.isClickable != new.isClickable ||
    old.isEnabled != new.isEnabled ||
    old.isFocused != new.isFocused ||
    old.isSelected != new.isSelected ||
    old.isScrollable != new.isScrollable ||
    old.isCheckable != new.isCheckable ||
    old.isChecked != new.isChecked ||
    old.children.size != new.children.size
}
