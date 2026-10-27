package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/** Set the selected element by ID. */
fun LayoutInspectorState.selectElement(elementId: String?) {
  selectedElementId = elementId
  selectedElement = elementId?.let { currentElementMap[it] }
}

/** Set the hovered element by ID. */
fun LayoutInspectorState.hoverElement(elementId: String?) {
  hoveredElementId = elementId
}

/** Toggle tap target compliance highlighting. */
fun LayoutInspectorState.toggleTapTargetIssues() {
  showTapTargetIssues = !showTapTargetIssues
}

/** Clear selection. */
fun LayoutInspectorState.clearSelection() {
  selectedElementId = null
  selectedElement = null
}

/** Clear the changed elements set. Called after flash animation completes. */
fun LayoutInspectorState.clearChangedElements() {
  changedElementIds = emptySet()
}
