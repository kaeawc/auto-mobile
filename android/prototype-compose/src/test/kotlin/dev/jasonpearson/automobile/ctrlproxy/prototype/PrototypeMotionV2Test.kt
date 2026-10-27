package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeStyleWhen
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeMotionV2Test {
  @Test
  fun `start and end slides mirror in right-to-left layouts`() {
    assertEquals(-100, prototypeSlideOffset("slideStart", 100, rtl = false))
    assertEquals(100, prototypeSlideOffset("slideEnd", 100, rtl = false))
    assertEquals(100, prototypeSlideOffset("slideStart", 100, rtl = true))
    assertEquals(-100, prototypeSlideOffset("slideEnd", 100, rtl = true))
  }

  @Test
  fun `a double tap zooms a resting image to 2x or its max, and resets a zoomed one`() {
    assertEquals(2f, PrototypeZoom.toggle(1f, 4f))
    assertEquals(1.5f, PrototypeZoom.toggle(1f, 1.5f))
    assertEquals(1f, PrototypeZoom.toggle(3f, 4f))
  }

  @Test
  fun `zoom actions stay within 1 and the max`() {
    assertEquals(1.5f, PrototypeZoom.zoomIn(1f, 4f))
    assertEquals(4f, PrototypeZoom.zoomIn(3f, 4f))
    assertEquals(1f, PrototypeZoom.zoomOut(1.2f))
  }

  @Test
  fun `pan stays within half the scaled overflow and is pinned at rest`() {
    val size = IntSize(200, 100)
    assertEquals(Offset(100f, -50f), PrototypeZoom.clampPan(Offset(500f, -500f), 2f, size))
    assertEquals(Offset(10f, 5f), PrototypeZoom.clampPan(Offset(10f, 5f), 2f, size))
    assertEquals(Offset.Zero, PrototypeZoom.clampPan(Offset(30f, 30f), 1f, size))
  }

  @Test
  fun `styleWhen sets scale and rotation and keeps the base ones it does not name`() {
    val liked = PrototypeCondition("liked", equals = PrototypeScalar.BooleanValue(true))
    val base = PrototypeStyle(scale = 1.0, rotation = 5.0)
    val styleWhen = listOf(PrototypeStyleWhen(liked, PrototypeStyle(scale = 1.4)))
    val on = mapOf("liked" to PrototypeScalar.BooleanValue(true))
    val off = mapOf("liked" to PrototypeScalar.BooleanValue(false))
    assertEquals(
      1.4 to 5.0,
      resolvePrototypeStyle(base, styleWhen, on).let { it.scale to it.rotation },
    )
    assertEquals(
      1.0 to 5.0,
      resolvePrototypeStyle(base, styleWhen, off).let { it.scale to it.rotation },
    )
  }
}
