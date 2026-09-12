package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.HighlightBounds
import dev.jasonpearson.automobile.protocol.HighlightShape
import org.junit.Assert.assertEquals
import org.junit.Test

class HighlightShapeConvertersTest {
  @Test
  fun `circle preserves bounds and coordinate space`() {
    val model =
      HighlightShape(
          type = "circle",
          bounds =
            HighlightBounds(
              x = 10,
              y = 20,
              width = 100,
              height = 50,
              sourceWidth = 1080,
              sourceHeight = 1920,
            ),
        )
        .toModel()
    assertEquals("circle", model.type)
    assertEquals(10, model.bounds?.x)
    assertEquals(20, model.bounds?.y)
    assertEquals(100, model.bounds?.width)
    assertEquals(50, model.bounds?.height)
    assertEquals(1080, model.bounds?.sourceWidth)
    assertEquals(1920, model.bounds?.sourceHeight)
  }
}
