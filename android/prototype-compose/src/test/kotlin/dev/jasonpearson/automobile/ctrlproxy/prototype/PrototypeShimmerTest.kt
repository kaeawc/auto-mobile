package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeShimmerTest {
  @Test
  fun `the sweep enters before the start and leaves past the end`() {
    assertEquals(-50f, prototypeShimmerCentre(0f, 100f, 50f))
    assertEquals(50f, prototypeShimmerCentre(0.5f, 100f, 50f))
    assertEquals(150f, prototypeShimmerCentre(1f, 100f, 50f))
  }
}
