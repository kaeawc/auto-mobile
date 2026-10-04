package dev.jasonpearson.automobile.discover

internal data class DragReorderResult(val index: Int, val remainingOffset: Float)

internal fun calculateDragReorder(
  currentIndex: Int,
  lastIndex: Int,
  accumulatedOffset: Float,
  rowStridePx: Float,
): DragReorderResult {
  val rowsCrossed = (accumulatedOffset / rowStridePx).toInt()
  val newIndex = (currentIndex + rowsCrossed).coerceIn(0, lastIndex)
  val remainingOffset = accumulatedOffset - (newIndex - currentIndex) * rowStridePx
  // Discard outward movement at either edge so it cannot accumulate or delay reversing direction.
  val clampedOffset =
    if (
      (newIndex == 0 && remainingOffset < 0f) || (newIndex == lastIndex && remainingOffset > 0f)
    ) {
      0f
    } else {
      remainingOffset
    }
  return DragReorderResult(newIndex, clampedOffset)
}

// Keep gesture ownership independent of recomposition and each row's pointer detector.
internal class DragReorderState(
  private val items: MutableList<DraggableListItem>,
  private val onStateChanged: (Int?, Float) -> Unit = { _, _ -> },
) {
  var draggingItemId: Int? = null
    private set

  var dragOffset: Float = 0f
    private set

  fun start(itemId: Int) {
    if (draggingItemId != null || items.none { it.id == itemId }) return
    draggingItemId = itemId
    dragOffset = 0f
    onStateChanged(draggingItemId, dragOffset)
  }

  fun move(itemId: Int, deltaY: Float, rowStridePx: Float) {
    if (draggingItemId != itemId) return
    val currentIndex = items.indexOfFirst { it.id == itemId }
    if (currentIndex == -1) return
    val result =
      calculateDragReorder(currentIndex, items.lastIndex, dragOffset + deltaY, rowStridePx)
    if (result.index != currentIndex) {
      val movedItem = items.removeAt(currentIndex)
      items.add(result.index, movedItem)
    }
    dragOffset = result.remainingOffset
    onStateChanged(draggingItemId, dragOffset)
  }

  fun end(itemId: Int) = finish(itemId)

  fun cancel(itemId: Int) = finish(itemId)

  private fun finish(itemId: Int) {
    if (draggingItemId != itemId) return
    draggingItemId = null
    dragOffset = 0f
    onStateChanged(draggingItemId, dragOffset)
  }
}
