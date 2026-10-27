package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import kotlin.math.max
import kotlin.math.min

/** Rectangle clipping and stable sweep-line union area. */
internal object OcclusionGeometry {
  /** Clip coverage only; retain the framework's node bounds for targets and host output. */
  internal fun clipOccluderBounds(
    bounds: ElementBounds,
    windowBounds: ElementBounds?,
  ): ElementBounds? =
    if (windowBounds == null || windowBounds.hasZeroArea()) bounds
    else intersectBounds(bounds, windowBounds)

  fun intersectBounds(bounds: ElementBounds, other: ElementBounds): ElementBounds? {
    val left = max(bounds.left, other.left)
    val top = max(bounds.top, other.top)
    val right = min(bounds.right, other.right)
    val bottom = min(bounds.bottom, other.bottom)

    if (left >= right || top >= bottom) {
      return null
    }

    return ElementBounds(left, top, right, bottom)
  }

  internal fun calculateUnionArea(rectangles: List<ElementBounds>, maxArea: Int? = null): Int {
    data class Event(val x: Int, val y1: Int, val y2: Int, val delta: Int)

    val events =
      rectangles
        .flatMap { rect ->
          listOf(
            Event(rect.left, rect.top, rect.bottom, 1),
            Event(rect.right, rect.top, rect.bottom, -1),
          )
        }
        .sortedBy { it.x }

    if (events.isEmpty()) return 0

    val sweep = SweepIntervals()
    var previousX = events.first().x
    var area = 0

    for (event in events) {
      val dx = event.x - previousX
      if (dx > 0 && sweep.isNotEmpty()) {
        val unionLength = sweep.activeUnionLength()
        area += unionLength * dx
        if (maxArea != null && area >= maxArea) {
          return area
        }
      }

      if (event.delta > 0) sweep.add(event.y1, event.y2) else sweep.remove(event.y1, event.y2)

      previousX = event.x
    }

    return area
  }

  private class SweepIntervals {
    private val activeIntervals = mutableListOf<Pair<Int, Int>>()

    fun isNotEmpty(): Boolean = activeIntervals.isNotEmpty()

    fun activeUnionLength(): Int {
      if (activeIntervals.isEmpty()) return 0
      var total = 0
      var currentStart = activeIntervals[0].first
      var currentEnd = activeIntervals[0].second

      for (i in 1 until activeIntervals.size) {
        val (start, end) = activeIntervals[i]
        if (start > currentEnd) {
          total += currentEnd - currentStart
          currentStart = start
          currentEnd = end
        } else {
          currentEnd = max(currentEnd, end)
        }
      }
      total += currentEnd - currentStart
      return total
    }

    fun add(y1: Int, y2: Int) {
      // Insert after equal starts to preserve sortedBy's stable tie order.
      var low = 0
      var high = activeIntervals.size
      while (low < high) {
        val middle = (low + high) ushr 1
        if (activeIntervals[middle].first <= y1) low = middle + 1 else high = middle
      }
      activeIntervals.add(low, y1 to y2)
    }

    fun remove(y1: Int, y2: Int) {

      var low = 0
      var high = activeIntervals.size
      while (low < high) {
        val middle = (low + high) ushr 1
        if (activeIntervals[middle].first < y1) low = middle + 1 else high = middle
      }
      while (low < activeIntervals.size && activeIntervals[low].first == y1) {
        if (activeIntervals[low].second == y2) {
          activeIntervals.removeAt(low)
          break
        }
        low++
      }
    }
  }
}
