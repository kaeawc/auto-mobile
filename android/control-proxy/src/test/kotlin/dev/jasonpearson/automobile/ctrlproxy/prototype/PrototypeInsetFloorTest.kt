package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.Gravity
import org.junit.Assert.assertEquals
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
}
