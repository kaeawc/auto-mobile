package dev.jasonpearson.automobile.discover.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect

internal data class GridDropCell(val index: Int, val bounds: Rect)

// Offsets and bounds are in the grid's untransformed layout coordinates, in pixels.
internal fun calculateGridDropTarget(
  itemIds: List<String>,
  draggedItemId: String,
  cells: List<GridDropCell>,
  dragOffset: Offset,
): Int {
  val currentIndex = itemIds.indexOf(draggedItemId)
  if (currentIndex == -1) return -1
  val source = cells.firstOrNull { it.index == currentIndex } ?: return -1
  val draggedCenter = source.bounds.center + dragOffset
  // Nearest centre preserves edge clamping and makes gaps between cells valid drop positions.
  return cells
    .filter { it.index in itemIds.indices }
    .minByOrNull { (it.bounds.center - draggedCenter).getDistanceSquared() }
    ?.index ?: -1
}
