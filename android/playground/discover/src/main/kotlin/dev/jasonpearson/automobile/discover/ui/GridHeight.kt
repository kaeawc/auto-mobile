package dev.jasonpearson.automobile.discover.ui

internal fun calculateGridHeightPx(
  maxWidthPx: Int,
  itemCount: Int,
  columns: Int,
  spacingPx: Int,
): Int {
  val rows = (itemCount + columns - 1) / columns
  val availableWidth = (maxWidthPx - spacingPx * (columns + 1)).coerceAtLeast(0)
  // Round up to the widest measured column so pixel rounding cannot clip the last row.
  val cellSizePx = (availableWidth + columns - 1) / columns
  return cellSizePx * rows + spacingPx * (rows - 1).coerceAtLeast(0) + spacingPx * 2
}
