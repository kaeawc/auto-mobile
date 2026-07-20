package dev.jasonpearson.automobile.junit

import kotlin.test.Test
import kotlin.test.assertEquals

class MemoryFormattingTest {

  @Test
  fun `formats a positive byte count as mebibytes`() {
    assertEquals("1.50 MiB", formatMebibytes(1_572_864))
  }

  @Test
  fun `hides negative values unless explicitly requested`() {
    assertEquals("unknown", formatMebibytes(-1))
    assertEquals("-0.00 MiB", formatMebibytes(-1, showNegative = true))
  }
}
