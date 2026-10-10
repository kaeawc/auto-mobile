package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayDimension
import dev.jasonpearson.automobile.protocol.OverlayStyle
import org.junit.Assert.assertEquals
import org.junit.Test

class OverlayPagerSizingTest {
  @Test
  fun `a pager authored without a size keeps filling its pages`() {
    assertEquals(OverlayPageFill(width = true, height = true), overlayPageFill(OverlayStyle()))
  }

  @Test
  fun `fill and dp pagers fill their pages`() {
    val style = OverlayStyle(width = OverlayDimension.Fill, height = OverlayDimension.Dp(120.0))
    assertEquals(OverlayPageFill(width = true, height = true), overlayPageFill(style))
  }

  @Test
  fun `a pager that is explicitly wrap tall lets pages take their content height`() {
    // A floating wrap pager: a full-height page made the window span the screen (#10086).
    val style = OverlayStyle(width = OverlayDimension.Wrap, height = OverlayDimension.Wrap)
    assertEquals(OverlayPageFill(width = false, height = false), overlayPageFill(style))
  }

  @Test
  fun `each axis is decided independently`() {
    assertEquals(
      OverlayPageFill(width = true, height = false),
      overlayPageFill(OverlayStyle(width = OverlayDimension.Fill, height = OverlayDimension.Wrap)),
    )
    assertEquals(
      OverlayPageFill(width = false, height = true),
      overlayPageFill(OverlayStyle(width = OverlayDimension.Wrap)),
    )
  }
}
