package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeGridColumns
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeFlowGridLayoutTest {
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
