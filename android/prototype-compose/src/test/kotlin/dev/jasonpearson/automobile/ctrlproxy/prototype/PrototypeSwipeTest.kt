package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeSwipeTest {
  // Density 1 so pixels equal dp: a 360 wide row, two end buttons (160), one start button (80).
  private val g = SwipeGeometry(80f, 160f, 360f, fullSwipe = false, density = 1f)
  private val full = g.copy(fullSwipe = true)

  @Test
  fun `a slow release past forty percent of the reveal opens and short of it closes`() {
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-64f, 0f, g))
    assertEquals(SwipeSettle.Closed, swipeSettle(-63f, 0f, g))
    assertEquals(SwipeSettle.Open(SwipeSide.START), swipeSettle(32f, 0f, g))
    assertEquals(SwipeSettle.Closed, swipeSettle(31f, 0f, g))
  }

  @Test
  fun `a fling decides regardless of position`() {
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-10f, -500f, g))
    assertEquals(SwipeSettle.Closed, swipeSettle(-150f, 500f, g))
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-150f, 499f, g))
  }

  @Test
  fun `a side without actions never opens and resists entirely`() {
    val onlyEnd = g.copy(startWidth = 0f)
    assertEquals(SwipeSettle.Closed, swipeSettle(50f, 900f, onlyEnd))
    assertEquals(0f, swipeRubberBand(50f, onlyEnd), 0f)
  }

  @Test
  fun `dragging inside the reveal is free and beyond it is rubber banded`() {
    assertEquals(-100f, swipeRubberBand(-100f, g), 0f)
    assertEquals(-160f, swipeRubberBand(-160f, g), 0f)
    assertEquals(-175f, swipeRubberBand(-210f, g), 0.001f)
    assertEquals(92f, swipeRubberBand(120f, g), 0.001f)
  }

  @Test
  fun `with fullSwipe the free range is the whole row`() {
    assertEquals(-300f, swipeRubberBand(-300f, full), 0f)
    assertEquals(-360f - 30f, swipeRubberBand(-460f, full), 0.001f)
  }

  @Test
  fun `a full swipe needs fullSwipe and either sixty percent of the row or a hard fling`() {
    assertEquals(SwipeSettle.Full(SwipeSide.END), swipeSettle(-217f, 0f, full))
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-215f, 0f, full))
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-217f, 0f, g))
    assertEquals(SwipeSettle.Full(SwipeSide.END), swipeSettle(-170f, -1800f, full))
    // A hard fling inside the revealed width only opens.
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-100f, -1800f, full))
    assertEquals(SwipeSettle.Full(SwipeSide.START), swipeSettle(217f, 0f, full))
  }

  @Test
  fun `thresholds scale with density`() {
    val dense = g.copy(density = 2f)
    assertEquals(SwipeSettle.Closed, swipeSettle(-10f, -900f, dense))
    assertEquals(SwipeSettle.Open(SwipeSide.END), swipeSettle(-10f, -1000f, dense))
  }

  @Test
  fun `rest offsets are closed the revealed width or off the row`() {
    assertEquals(0f, swipeRestOffset(SwipeSettle.Closed, g), 0f)
    assertEquals(-160f, swipeRestOffset(SwipeSettle.Open(SwipeSide.END), g), 0f)
    assertEquals(80f, swipeRestOffset(SwipeSettle.Open(SwipeSide.START), g), 0f)
    assertEquals(-360f, swipeRestOffset(SwipeSettle.Full(SwipeSide.END), g), 0f)
  }

  @Test
  fun `the edge button absorbs extra reveal and the others keep their width`() {
    assertEquals(listOf(80f, 80f), swipeButtonWidths(2, 160f, 80f))
    assertEquals(listOf(230f, 80f), swipeButtonWidths(2, 310f, 80f))
    assertEquals(listOf(80f, 80f), swipeButtonWidths(2, 40f, 80f))
    assertEquals(emptyList<Float>(), swipeButtonWidths(0, 100f, 80f))
  }

  @Test
  fun `opening a row closes the previously open one and only one is open`() {
    val coordinator = SwipeCoordinator()
    assertNull(coordinator.opened("a"))
    assertEquals("a", coordinator.opened("b"))
    assertTrue(coordinator.isOpen("b"))
    assertFalse(coordinator.isOpen("a"))
    assertNull(coordinator.opened("b"))
    coordinator.closed("a")
    assertTrue(coordinator.isOpen("b"))
    coordinator.closed("b")
    assertNull(coordinator.openRow)
  }
}
