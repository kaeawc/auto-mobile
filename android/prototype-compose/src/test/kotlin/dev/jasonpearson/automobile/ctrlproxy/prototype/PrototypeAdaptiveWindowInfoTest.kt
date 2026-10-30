package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.adaptive.Posture
import androidx.compose.ui.unit.IntSize
import androidx.window.core.layout.WindowSizeClass
import org.junit.Assert.*
import org.junit.Test

class PrototypeAdaptiveWindowInfoTest {
  @Test
  fun compactWidthUsesDpRatherThanPixels() {
    assertSizeClass(1199, 2f, 599.5f)
  }

  @Test
  fun mediumWidthStartsAt600Dp() {
    assertSizeClass(1200, 2f, 600f)
    assertSizeClass(1679, 2f, 839.5f)
  }

  @Test
  fun expandedWidthStartsAt840Dp() {
    assertSizeClass(1680, 2f, 840f)
  }

  private fun assertSizeClass(widthPx: Int, density: Float, widthDp: Float) {
    val info = prototypeAdaptiveWindowInfo(IntSize(widthPx, 900), density, PrototypeFold.NONE)
    assertEquals(WindowSizeClass.compute(widthDp, 450f), info.windowSizeClass)
  }

  @Test
  fun horizontalHalfOpenedFoldMapsToTabletopPosture() {
    val info =
      prototypeAdaptiveWindowInfo(IntSize(1800, 1200), 2f, PrototypeFold.HALF_OPENED_HORIZONTAL)
    assertTrue(info.windowPosture.isTabletop)
    assertTrue(info.windowPosture.hingeList.isEmpty())
  }

  @Test
  fun otherFoldStatesMapToNonTabletopPosture() {
    listOf(PrototypeFold.NONE, PrototypeFold.FLAT, PrototypeFold.HALF_OPENED_VERTICAL).forEach {
      fold ->
      val info = prototypeAdaptiveWindowInfo(IntSize(1800, 1200), 2f, fold)
      assertEquals(Posture(), info.windowPosture)
    }
  }
}
