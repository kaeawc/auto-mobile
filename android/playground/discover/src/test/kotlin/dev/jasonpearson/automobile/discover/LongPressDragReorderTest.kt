package dev.jasonpearson.automobile.discover

import org.junit.Assert.assertEquals
import org.junit.Test

class LongPressDragReorderTest {

  @Test
  fun `does not move below one row stride in either direction`() {
    assertEquals(DragReorderResult(2, 63f), calculateDragReorder(2, 4, 63f, 64f))
    assertEquals(DragReorderResult(2, -63f), calculateDragReorder(2, 4, -63f, 64f))
  }

  @Test
  fun `moves down by one row at the threshold`() {
    assertEquals(DragReorderResult(3, 0f), calculateDragReorder(2, 4, 64f, 64f))
  }

  @Test
  fun `moves up by one row at the threshold`() {
    assertEquals(DragReorderResult(1, 0f), calculateDragReorder(2, 4, -64f, 64f))
  }

  @Test
  fun `preserves signed leftover offset after crossing a row`() {
    assertEquals(DragReorderResult(3, 14f), calculateDragReorder(2, 4, 78f, 64f))
    assertEquals(DragReorderResult(1, -14f), calculateDragReorder(2, 4, -78f, 64f))
  }

  @Test
  fun `jumps multiple rows and subtracts all crossed strides`() {
    assertEquals(DragReorderResult(3, 18f), calculateDragReorder(0, 4, 210f, 64f))
    assertEquals(DragReorderResult(1, -18f), calculateDragReorder(4, 4, -210f, 64f))
  }

  @Test
  fun `clamps overshoot at both ends and discards outward offset`() {
    assertEquals(DragReorderResult(4, 0f), calculateDragReorder(2, 4, 350f, 64f))
    assertEquals(DragReorderResult(0, 0f), calculateDragReorder(2, 4, -350f, 64f))
  }

  @Test
  fun `discards outward offset even below a row stride at an edge`() {
    assertEquals(DragReorderResult(4, 0f), calculateDragReorder(4, 4, 20f, 64f))
    assertEquals(DragReorderResult(0, 0f), calculateDragReorder(0, 4, -20f, 64f))
  }

  @Test
  fun `reverses immediately after repeated movement against an edge`() {
    val atBottom = calculateDragReorder(3, 4, 200f, 64f)
    val stillAtBottom =
      calculateDragReorder(atBottom.index, 4, atBottom.remainingOffset + 200f, 64f)
    assertEquals(DragReorderResult(4, 0f), stillAtBottom)
    assertEquals(
      DragReorderResult(3, -14f),
      calculateDragReorder(stillAtBottom.index, 4, stillAtBottom.remainingOffset - 78f, 64f),
    )
  }

  @Test
  fun `uses the current index and leftover offset for successive moves`() {
    val first = calculateDragReorder(1, 4, 78f, 64f)
    assertEquals(DragReorderResult(2, 14f), first)
    assertEquals(
      DragReorderResult(3, 8f),
      calculateDragReorder(first.index, 4, first.remainingOffset + 58f, 64f),
    )
  }
}
