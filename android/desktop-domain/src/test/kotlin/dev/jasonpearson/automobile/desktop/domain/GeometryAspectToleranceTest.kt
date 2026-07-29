package dev.jasonpearson.automobile.desktop.domain

import kotlin.test.Test
import kotlin.test.assertEquals

class GeometryAspectToleranceTest {

  @Test
  fun `shared tolerance remains five percent`() {
    assertEquals(5f / 100f, GEOMETRY_ASPECT_TOLERANCE)
  }
}
