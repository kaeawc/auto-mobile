package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeStylePolishTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmPureHelpers() {
      prototypeVisibleFades(true, LayoutDirection.Ltr, true, true, PrototypeFadeEdges(start = 1.0))
      prototypeImageColorMatrix()
      prototypeResolvedShadow(
        PrototypeShadow(PrototypeModeValue.Single("#000000"), 8.0),
        Color.Black,
        1f,
      )
    }
  }

  private fun shadow(radius: Double = 8.0, inner: Boolean? = null) =
    PrototypeShadow(PrototypeModeValue.Single("#000000"), radius, inner = inner)

  @Test
  fun `shadow groups preserve array order and defaults`() {
    val first = shadow()
    val inside = shadow(2.0, true)
    val last = shadow(4.0, false)
    val layers = listOf(first, inside, last)
    assertEquals(listOf(first, last), prototypeShadowLayers(layers, false))
    assertEquals(listOf(inside), prototypeShadowLayers(layers, true))
    assertEquals(emptyList<PrototypeShadow>(), prototypeShadowLayers(null, false))
    assertEquals(PrototypeShadowPixels(8f, 0f, 0f, 0f), prototypeShadowPixels(first, 2f))
  }

  @Test
  fun `shadow dp converts spread offsets and CSS sigma to pixels`() {
    val layer = shadow().copy(spread = -3.0, offset = PrototypeShadowOffset(4.0, -2.0))
    assertEquals(PrototypeShadowPixels(12f, -9f, 12f, -6f), prototypeShadowPixels(layer, 3f))
    assertEquals(0f, prototypeShadowRadius(0f, 3f))
    val resolved = prototypeResolvedShadow(layer, Color.Red, 3f)
    assertEquals(Color.Red, resolved.color)
    assertEquals(-3f, resolved.spread.value)
    assertEquals(4f, resolved.offset.x.value)
    assertEquals(-2f, resolved.offset.y.value)
    val nativeRadius = resolved.radius.value * 3f
    assertEquals(12f, nativeRadius * 0.57735f + 0.5f, 0.0001f)
    assertTrue(prototypeShadowRadius(0.1f, 1f) > 0f)
  }

  @Test
  fun `vertical fades follow scrollability and ignore horizontal edges`() {
    val spec = PrototypeFadeEdges(top = 10.0, bottom = 20.0, start = 30.0, end = 40.0)
    for (direction in LayoutDirection.entries) {
      for (backward in listOf(false, true)) for (forward in listOf(false, true)) {
        val expected = buildList {
          if (backward) add(PrototypeVisibleFade(PrototypeFadeEdge.TOP, 10f))
          if (forward) add(PrototypeVisibleFade(PrototypeFadeEdge.BOTTOM, 20f))
        }
        assertEquals(expected, prototypeVisibleFades(false, direction, backward, forward, spec))
      }
    }
  }

  @Test
  fun `horizontal fades mirror start and end in RTL for every scroll state`() {
    val spec = PrototypeFadeEdges(top = 10.0, bottom = 20.0, start = 30.0, end = 40.0)
    for (direction in LayoutDirection.entries) {
      val start =
        if (direction == LayoutDirection.Ltr) PrototypeFadeEdge.LEFT else PrototypeFadeEdge.RIGHT
      val end =
        if (direction == LayoutDirection.Ltr) PrototypeFadeEdge.RIGHT else PrototypeFadeEdge.LEFT
      for (backward in listOf(false, true)) for (forward in listOf(false, true)) {
        val expected = buildList {
          if (backward) add(PrototypeVisibleFade(start, 30f))
          if (forward) add(PrototypeVisibleFade(end, 40f))
        }
        assertEquals(expected, prototypeVisibleFades(true, direction, backward, forward, spec))
      }
    }
  }

  @Test
  fun `absent zero and irrelevant fades produce no mask`() {
    assertTrue(prototypeVisibleFades(false, LayoutDirection.Ltr, true, true, null).isEmpty())
    assertTrue(
      prototypeVisibleFades(
          false,
          LayoutDirection.Ltr,
          true,
          true,
          PrototypeFadeEdges(top = 0.0, start = 12.0),
        )
        .isEmpty(),
    )
    assertTrue(
      prototypeVisibleFades(
          true,
          LayoutDirection.Rtl,
          true,
          true,
          PrototypeFadeEdges(bottom = 12.0, end = 0.0),
        )
        .isEmpty(),
    )
  }

  @Test
  fun `identity saturation and default tint preserve all channels`() {
    val matrix = prototypeImageColorMatrix()
    for (row in 0..3) for (column in 0..4) {
      assertEquals(if (row == column) 1f else 0f, matrix[row, column], 0.0001f)
    }
  }

  @Test
  fun `grayscale uses luminance and saturation two retains oversaturated coefficients`() {
    val gray = prototypeImageColorMatrix(0f)
    assertEquals(gray[0, 0], gray[1, 0], 0.0001f)
    assertEquals(1f, gray[0, 0] + gray[0, 1] + gray[0, 2], 0.0001f)
    assertEquals(1f, gray[3, 3], 0.0001f)
    val oversaturated = prototypeImageColorMatrix(2f)
    assertTrue(oversaturated[0, 0] > 1f)
    assertTrue(oversaturated[0, 1] < 0f)
  }

  @Test
  fun `fade geometry clamps to viewport and runs inward from each physical edge`() {
    val size = Size(100f, 80f)
    assertEquals(
      Offset.Zero to Offset(0f, 20f),
      prototypeFadeLine(PrototypeFadeEdge.TOP, 20f, size),
    )
    assertEquals(
      Offset(0f, 80f) to Offset.Zero,
      prototypeFadeLine(PrototypeFadeEdge.BOTTOM, 1000f, size),
    )
    assertEquals(
      Offset.Zero to Offset(100f, 0f),
      prototypeFadeLine(PrototypeFadeEdge.LEFT, 1000f, size),
    )
    assertEquals(
      Offset(100f, 0f) to Offset(75f, 0f),
      prototypeFadeLine(PrototypeFadeEdge.RIGHT, 25f, size),
    )
    assertNull(prototypeFadeLine(PrototypeFadeEdge.TOP, 20f, Size.Zero))
  }
}
