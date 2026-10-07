package dev.jasonpearson.automobile.design.system.components

import org.junit.Assert.assertEquals
import org.junit.Test

class CrayonGrainTest {
  @Test
  fun api33_usesShader() {
    assertEquals(CrayonGrainPath.SHADER, crayonGrainPath(33))
  }

  @Test
  fun api32_usesFallback() {
    assertEquals(CrayonGrainPath.FALLBACK, crayonGrainPath(32))
  }

  @Test
  fun minSdk24_usesFallback() {
    assertEquals(CrayonGrainPath.FALLBACK, crayonGrainPath(24))
  }

  @Test
  fun api36_usesShader() {
    assertEquals(CrayonGrainPath.SHADER, crayonGrainPath(36))
  }
}
