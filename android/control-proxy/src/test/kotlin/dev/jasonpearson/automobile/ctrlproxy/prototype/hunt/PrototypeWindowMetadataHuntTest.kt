package dev.jasonpearson.automobile.ctrlproxy.prototype.hunt

import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeWindowMetadata
import dev.jasonpearson.automobile.protocol.PrototypeBoxNode
import dev.jasonpearson.automobile.protocol.PrototypeCornerRadius
import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeOffset
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeWindowMetadataHuntTest {
  private fun opaque(style: PrototypeStyle): Boolean {
    val spec =
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = PrototypeBoxNode(style = style, children = emptyList()),
      )
    return prototypeWindowMetadata(mapPrototypeSpec(spec), dismissBarOpaque = true).opaque
  }

  private val solidFill =
    PrototypeStyle(
      width = PrototypeDimension.Fill,
      height = PrototypeDimension.Fill,
      background = PrototypeModeValue.Single("#FF101010"),
    )

  @Test
  fun `control - an unrounded solid fill root is opaque`() {
    assertTrue(opaque(solidFill))
  }

  @Test
  fun `a rounded root lets the app show through its corners`() {
    assertFalse(opaque(solidFill.copy(cornerRadius = PrototypeCornerRadius.Dp(48.0))))
  }

  @Test
  fun `an offset root leaves an edge of the app uncovered`() {
    assertFalse(opaque(solidFill.copy(offset = PrototypeOffset(120.0, 0.0))))
  }

  @Test
  fun `a root capped by maxWidth does not span the window`() {
    assertFalse(opaque(solidFill.copy(maxWidth = 200.0)))
  }
}
