package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.Gravity
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.union
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.PrototypeBounds
import dev.jasonpearson.automobile.protocol.PrototypeBoundsAnchor
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The #10156 device run: 1080x2400 at density 2.625 with a 63 px (24 dp) gesture navigation bar.
 * The control row sat at the screen's bottom edge with no bottom padding; these pin which
 * placements the host promises to keep clear of the bar. Whether the row then really clears it on a
 * device is a device check, not something a JVM test can show.
 */
class PrototypeInsetFloorTest {
  private val density = 2.625f
  private val bar = 63

  private fun floor(placement: PrototypePlacement, navigationBar: Int = bar) =
    prototypeInsetFloor(placement, density, navigationBar).bottom

  @Test
  fun `fullscreen sits behind the whole navigation bar`() {
    assertEquals(63, floor(PrototypePlacement.Fullscreen()))
  }

  @Test
  fun `a bottom floating window at the edge sits behind the whole bar`() {
    val bottomCenter =
      PrototypePlacement.Floating(gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
    assertEquals(63, floor(bottomCenter))
  }

  @Test
  fun `a bottom floating window lifted by its offset is behind only the rest of the bar`() {
    // 10 dp = 26 px (rounded) lifts a bottom-gravity window; 24 dp or more clears the bar.
    fun lifted(dp: Float) = PrototypePlacement.Floating(Gravity.BOTTOM, offsetYDp = dp)
    assertEquals(37, floor(lifted(10f)))
    assertEquals(0, floor(lifted(24f)))
    assertEquals(0, floor(lifted(100f)))
  }

  @Test
  fun `a bottom floating window pushed below the edge is behind more than the bar`() {
    assertEquals(89, floor(PrototypePlacement.Floating(Gravity.BOTTOM, offsetYDp = -10f)))
  }

  @Test
  fun `floating windows not anchored to the bottom are not behind the bar`() {
    assertEquals(0, floor(PrototypePlacement.Floating(Gravity.CENTER)))
    assertEquals(0, floor(PrototypePlacement.Floating(Gravity.TOP or Gravity.CENTER_HORIZONTAL)))
    assertEquals(0, floor(PrototypePlacement.Floating()))
  }

  @Test
  fun `sheets share the bottom edge except a top sheet`() {
    assertEquals(63, floor(PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 120f)))
    assertEquals(63, floor(PrototypePlacement.Sheet(PrototypePlacement.Edge.START, 120f)))
    assertEquals(63, floor(PrototypePlacement.Sheet(PrototypePlacement.Edge.END, 120f)))
    assertEquals(0, floor(PrototypePlacement.Sheet(PrototypePlacement.Edge.TOP, 120f)))
  }

  @Test
  fun `a hidden or unreadable bar leaves nothing to keep clear of`() {
    assertEquals(0, floor(PrototypePlacement.Fullscreen(), navigationBar = 0))
    assertEquals(0, floor(PrototypePlacement.Fullscreen(), navigationBar = -5))
  }

  @Test
  fun `AAOS fullscreen clears the 76 px top bar despite a 46 px window inset`() {
    // Captured AAOS API 35 display: 1024x768; overlay dispatch reports only 46 px at the top.
    val floor = prototypeInsetFloor(PrototypePlacement.Fullscreen(), 1f, 96, 76)
    assertEquals(76, floor.top)
    assertEquals(96, floor.bottom)
    val resolved = WindowInsets(0, 46, 0, 0).union(floor.asComposeInsets())
    assertEquals(76, resolved.getTop(Density(1f)))
    val largerWindowInset = WindowInsets(0, 100, 0, 0).union(floor.asComposeInsets())
    assertEquals(100, largerWindowInset.getTop(Density(1f)))
  }

  @Test
  fun `top floating offsets clear only the covered portion of the top bar`() {
    fun top(dp: Float) =
      prototypeInsetFloor(
          PrototypePlacement.Floating(Gravity.TOP or Gravity.CENTER_HORIZONTAL, offsetYDp = dp),
          density,
          bar,
          76,
        )
        .top
    assertEquals(76, top(0f))
    assertEquals(50, top(10f))
    assertEquals(0, top(29f))
    assertEquals(0, top(100f))
    assertEquals(102, top(-10f))
  }

  @Test
  fun `an anchored floating window below the top bar has no top floor`() {
    val floor =
      prototypeInsetFloor(
        PrototypePlacement.Floating(Gravity.TOP),
        density,
        bar,
        76,
        anchoredOriginYPx = 300,
      )
    assertEquals(0, floor.top)
  }

  @Test
  fun `an anchored floating window overlapping the top bar clears only the overlap`() {
    val floor =
      prototypeInsetFloor(
        PrototypePlacement.Floating(Gravity.TOP),
        density,
        bar,
        76,
        anchoredOriginYPx = 30,
      )
    assertEquals(46, floor.top)
  }

  @Test
  fun `a bottom-aligned anchored window's top floor converges instead of growing`() {
    val placement = PrototypePlacement.Floating(Gravity.TOP)
    val anchor = PrototypeBoundsAnchor(PrototypeBounds(0.0, 0.0, 100.0, 100.0), "bottom")
    val topBarPx = 76
    val contentHeightPx = 60
    val floors = mutableListOf(prototypeInsetFloor(placement, 1f, 0, topBarPx).top)
    repeat(8) {
      // prototypeAnchor measures the safe-area-padded root; the host receives its screen origin.
      val measuredHeightPx = contentHeightPx + floors.last()
      val origin =
        prototypeAnchorRect(anchor, 1f, 60f, measuredHeightPx.toFloat(), LayoutDirection.Ltr)
      floors +=
        prototypeInsetFloor(
            placement,
            1f,
            0,
            topBarPx,
            anchoredOriginYPx = origin.top.roundToInt(),
          )
          .top
    }
    assertEquals(topBarPx, floors.first())
    assertTrue(floors.all { it in 0..topBarPx })
    floors.zipWithNext().forEach { (previous, next) -> assertEquals(previous, next) }
  }

  @Test
  fun `other placements have no top floor`() {
    val placements =
      listOf(
        PrototypePlacement.Floating(Gravity.CENTER),
        PrototypePlacement.Floating(Gravity.BOTTOM),
        PrototypePlacement.Sheet(PrototypePlacement.Edge.TOP, 120f),
        PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 120f),
        PrototypePlacement.Sheet(PrototypePlacement.Edge.START, 120f),
        PrototypePlacement.Sheet(PrototypePlacement.Edge.END, 120f),
      )
    for (placement in placements) {
      assertEquals(0, prototypeInsetFloor(placement, density, bar, 76).top)
    }
  }

  @Test
  fun `a hidden or unreadable top bar leaves no top floor`() {
    assertEquals(0, prototypeInsetFloor(PrototypePlacement.Fullscreen(), density, bar, 0).top)
    assertEquals(0, prototypeInsetFloor(PrototypePlacement.Fullscreen(), density, bar, -5).top)
    assertEquals(0, prototypeInsetFloor(PrototypePlacement.Fullscreen(), density, bar).top)
    assertEquals(0, PrototypeInsetFloor(bottom = bar).top)
  }
}
