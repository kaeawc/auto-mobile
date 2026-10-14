package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeGridColumns
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeFlowGridLayoutTest {
  @Test
  fun `flow caps height including line gaps while retaining every placement`() {
    val sizes = listOf(40.0 to 10.0, 40.0 to 20.0, 70.0 to 30.0, 70.0 to 40.0)
    val all = prototypeFlowPlacement(sizes, 84.0, 4.0, 6.0, null)
    assertEquals(
      listOf(
        PrototypeFlowOffset(0.0, 0.0),
        PrototypeFlowOffset(44.0, 0.0),
        PrototypeFlowOffset(0.0, 26.0),
        PrototypeFlowOffset(0.0, 62.0),
      ),
      all.children,
    )
    assertEquals(84.0, all.width, 0.0)
    assertEquals(102.0, all.height, 0.0)
    val capped = prototypeFlowPlacement(sizes, 84.0, 4.0, 6.0, 2)
    assertEquals(56.0, capped.height, 0.0)
    assertEquals(all.children, capped.children)
    assertEquals(20.0, prototypeFlowPlacement(sizes, 84.0, 4.0, 6.0, 1).height, 0.0)
    assertEquals(all, prototypeFlowPlacement(sizes, 84.0, 4.0, 6.0, 10))
    assertEquals(
      PrototypeFlowPlacement(emptyList(), 0.0, 0.0),
      prototypeFlowPlacement(emptyList(), 84.0, 4.0, 6.0, 1),
    )
  }

  @Test
  fun `flow keeps an oversized first child and unbounded width on one line`() {
    val sizes = listOf(100.0 to 10.0, 20.0 to 30.0)
    assertEquals(
      listOf(PrototypeFlowOffset(0.0, 0.0), PrototypeFlowOffset(0.0, 16.0)),
      prototypeFlowPlacement(sizes, 80.0, 4.0, 6.0, null).children,
    )
    val unbounded = prototypeFlowPlacement(sizes, null, 4.0, 6.0, null)
    assertEquals(124.0, unbounded.width, 0.0)
    assertEquals(30.0, unbounded.height, 0.0)
  }

  @Test
  fun `adaptive counts include the gap and never fall below one`() {
    val columns = PrototypeGridColumns.Adaptive(100.0)
    assertEquals(3, prototypeGridColumnCount(columns, 320.0, 10.0))
    assertEquals(2, prototypeGridColumnCount(columns, 319.0, 10.0))
    assertEquals(1, prototypeGridColumnCount(columns, 0.0, 10.0))
    assertEquals(3, prototypeGridColumnCount(columns, 300.0, 0.0))
    assertEquals(4, prototypeGridColumnCount(PrototypeGridColumns.Fixed(4), 10.0, 20.0))
  }

  @Test
  fun `spans wrap without backfilling and clamp to the current column count`() {
    assertEquals(
      listOf(
        PrototypeGridCell(0, 0, 2),
        PrototypeGridCell(1, 0, 2),
        PrototypeGridCell(1, 2, 1),
        PrototypeGridCell(2, 0, 3),
        PrototypeGridCell(3, 0, 1),
      ),
      prototypeGridCells(3, listOf(2, 2, 1, 12, 1)),
    )
    assertEquals(emptyList<PrototypeGridCell>(), prototypeGridCells(3, emptyList()))
  }

  @Test
  fun `one column places every child on its own row`() {
    assertEquals(
      listOf(PrototypeGridCell(0, 0, 1), PrototypeGridCell(1, 0, 1)),
      prototypeGridCells(1, listOf(1, 12)),
    )
  }
}
