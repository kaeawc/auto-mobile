package dev.jasonpearson.automobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeKeyframesTest {
  private val points = listOf(0.0 to 1.0, 0.35 to 1.3, 1.0 to 1.0)

  @Test
  fun linearHitsAuthoredPoint() {
    assertEquals(1.3, keyframeValue(points, "linear", 0.35), 0.000001)
  }

  @Test
  fun curvesAreMonotonicAndEndpointsExact() {
    for (curve in listOf("linear", "standard", "spring")) {
      val segment = listOf(0.0 to 0.0, 1.0 to 1.0)
      assertEquals(0.0, keyframeValue(segment, curve, 0.0), 0.0)
      assertEquals(1.0, keyframeValue(segment, curve, 1.0), 0.0)
      val values = (0..100).map { keyframeValue(segment, curve, it / 100.0) }
      assertTrue(values.zipWithNext().all { (a, b) -> a <= b })
    }
  }
}
