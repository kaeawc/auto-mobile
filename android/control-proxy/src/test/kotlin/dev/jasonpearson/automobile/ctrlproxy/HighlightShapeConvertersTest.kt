package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.HighlightBounds
import dev.jasonpearson.automobile.protocol.HighlightLineCap
import dev.jasonpearson.automobile.protocol.HighlightLineJoin
import dev.jasonpearson.automobile.protocol.HighlightPoint
import dev.jasonpearson.automobile.protocol.HighlightShape
import dev.jasonpearson.automobile.protocol.HighlightStyle
import dev.jasonpearson.automobile.protocol.SmoothingAlgorithm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Verifies the protocol → render-model conversion for highlight shapes. The converters map enums by
 * name via `valueOf`, which throws if the two enum hierarchies ever drift, so every enum constant
 * (and every real field the TS client sends) is exercised here — not just the box smoke test in
 * [CtrlProxyMessageHandlerTest]. These are pure data mappings, so no Robolectric is needed.
 */
class HighlightShapeConvertersTest {

  @Test
  fun `box shape converts bounds`() {
    val model =
      HighlightShape(
          type = "box",
          bounds = HighlightBounds(x = 10, y = 20, width = 100, height = 50),
        )
        .toModel()

    assertEquals("box", model.type)
    assertEquals(10, model.bounds?.x)
    assertEquals(20, model.bounds?.y)
    assertEquals(100, model.bounds?.width)
    assertEquals(50, model.bounds?.height)
    assertNull(model.points)
    assertNull(model.style)
  }

  @Test
  fun `path shape converts points and style with cap and join`() {
    val model =
      HighlightShape(
          type = "path",
          points = listOf(HighlightPoint(1f, 2f), HighlightPoint(3f, 4f)),
          style =
            HighlightStyle(
              strokeColor = "#FF8800",
              strokeWidth = 5f,
              dashPattern = listOf(4f, 2f),
              smoothing = SmoothingAlgorithm.CATMULL_ROM,
              tension = 0.6f,
              capStyle = HighlightLineCap.ROUND,
              joinStyle = HighlightLineJoin.BEVEL,
            ),
        )
        .toModel()

    assertEquals("path", model.type)
    assertNull(model.bounds)
    assertEquals(listOf(1f to 2f, 3f to 4f), model.points?.map { it.x to it.y })
    assertEquals("#FF8800", model.style?.strokeColor)
    assertEquals(5f, model.style?.strokeWidth)
    assertEquals(listOf(4f, 2f), model.style?.dashPattern)
    assertEquals(0.6f, model.style?.tension)
    assertEquals("CATMULL_ROM", model.style?.smoothing?.name)
    assertEquals("ROUND", model.style?.capStyle?.name)
    assertEquals("BEVEL", model.style?.joinStyle?.name)
  }

  @Test
  fun `every smoothing algorithm maps by name`() {
    for (value in SmoothingAlgorithm.entries) {
      val model = HighlightShape(type = "path", style = HighlightStyle(smoothing = value)).toModel()
      assertEquals(value.name, model.style?.smoothing?.name)
    }
  }

  @Test
  fun `every line cap maps by name`() {
    for (value in HighlightLineCap.entries) {
      val model = HighlightShape(type = "path", style = HighlightStyle(capStyle = value)).toModel()
      assertEquals(value.name, model.style?.capStyle?.name)
    }
  }

  @Test
  fun `every line join maps by name`() {
    for (value in HighlightLineJoin.entries) {
      val model = HighlightShape(type = "path", style = HighlightStyle(joinStyle = value)).toModel()
      assertEquals(value.name, model.style?.joinStyle?.name)
    }
  }

  @Test
  fun `null nested fields stay null`() {
    val model = HighlightShape(type = "box").toModel()
    assertEquals("box", model.type)
    assertNull(model.bounds)
    assertNull(model.points)
    assertNull(model.style)
  }
}
