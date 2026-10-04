package dev.jasonpearson.automobile.discover

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import dev.jasonpearson.automobile.discover.ui.GridDropCell
import dev.jasonpearson.automobile.discover.ui.calculateGridDropTarget
import org.junit.Assert.assertEquals
import org.junit.Test

class GridDropTargetTest {
  private val ids = (1..6).map { it.toString() }

  private fun cells(columns: Int, size: Float, spacing: Float = 8f) =
    ids.indices.map { index ->
      val left = 8f + (index % columns) * (size + spacing)
      val top = 8f + (index / columns) * (size + spacing)
      GridDropCell(index, Rect(left, top, left + size, top + size))
    }

  @Test
  fun `phone layout maps horizontal and vertical centre to centre drags`() {
    val cells = cells(3, 88f)
    assertEquals(2, calculateGridDropTarget(ids, "1", cells, Offset(192f, 0f)))
    assertEquals(4, calculateGridDropTarget(ids, "2", cells, Offset(0f, 96f)))
    assertEquals(0, calculateGridDropTarget(ids, "1", cells, Offset.Zero))
  }

  @Test
  fun `foldable layout uses measured wide cells and a different column count`() {
    val cells = cells(4, 256f)
    assertEquals(1, calculateGridDropTarget(ids, "1", cells, Offset(264f, 0f)))
    assertEquals(5, calculateGridDropTarget(ids, "2", cells, Offset(0f, 264f)))
    assertEquals(0, calculateGridDropTarget(ids, "6", cells, Offset(-264f, -264f)))
  }

  @Test
  fun `foldable three column fixture uses actual cell bounds`() {
    val cells = cells(3, 640f, 20f)
    assertEquals(1, calculateGridDropTarget(ids, "1", cells, Offset(660f, 0f)))
    assertEquals(3, calculateGridDropTarget(ids, "1", cells, Offset(0f, 660f)))
  }

  @Test
  fun `drag after a reorder resolves the current source index by id`() {
    val cells = cells(3, 88f)
    val reordered = listOf("2", "3", "1", "4", "5", "6")
    assertEquals(0, calculateGridDropTarget(reordered, "2", cells, Offset.Zero))
    assertEquals(2, calculateGridDropTarget(reordered, "2", cells, Offset(192f, 0f)))
    assertEquals(0, calculateGridDropTarget(reordered, "1", cells, Offset(-192f, 0f)))
  }

  @Test
  fun `spacing and outside drops choose the nearest measured cell`() {
    val cells = cells(3, 88f)
    assertEquals(1, calculateGridDropTarget(ids, "1", cells, Offset(49f, 0f)))
    assertEquals(0, calculateGridDropTarget(ids, "1", cells, Offset(-1000f, -1000f)))
    assertEquals(5, calculateGridDropTarget(ids, "1", cells, Offset(1000f, 1000f)))
  }

  @Test
  fun `missing item or unmeasured source has no drop target`() {
    assertEquals(-1, calculateGridDropTarget(ids, "missing", cells(3, 88f), Offset.Zero))
    assertEquals(-1, calculateGridDropTarget(ids, "1", emptyList(), Offset.Zero))
    assertEquals(-1, calculateGridDropTarget(ids, "1", cells(3, 88f).drop(1), Offset.Zero))
  }
}
