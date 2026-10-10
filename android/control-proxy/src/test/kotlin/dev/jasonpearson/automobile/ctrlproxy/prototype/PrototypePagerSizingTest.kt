package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypePagerSizingTest {
  @Test
  fun `a pager authored without a size keeps filling its pages`() {
    assertEquals(
      PrototypePageFill(width = true, height = true),
      prototypePageFill(PrototypeStyle()),
    )
  }

  @Test
  fun `fill and dp pagers fill their pages`() {
    val style =
      PrototypeStyle(width = PrototypeDimension.Fill, height = PrototypeDimension.Dp(120.0))
    assertEquals(PrototypePageFill(width = true, height = true), prototypePageFill(style))
  }

  @Test
  fun `a pager that is explicitly wrap tall lets pages take their content height`() {
    // A floating wrap pager: a full-height page made the window span the screen (#10086).
    val style = PrototypeStyle(width = PrototypeDimension.Wrap, height = PrototypeDimension.Wrap)
    assertEquals(PrototypePageFill(width = false, height = false), prototypePageFill(style))
  }

  @Test
  fun `each axis is decided independently`() {
    assertEquals(
      PrototypePageFill(width = true, height = false),
      prototypePageFill(
        PrototypeStyle(width = PrototypeDimension.Fill, height = PrototypeDimension.Wrap),
      ),
    )
    assertEquals(
      PrototypePageFill(width = false, height = true),
      prototypePageFill(PrototypeStyle(width = PrototypeDimension.Wrap)),
    )
  }
}
