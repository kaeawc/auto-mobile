package dev.jasonpearson.automobile.junit

import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

class MemoryFormattingTest {

  @Test
  fun `memory log decimals remain invariant under German locale`() {
    val previous = Locale.getDefault()
    try {
      Locale.setDefault(Locale.GERMANY)
      assertEquals("1.50", formatMemoryDeltaMb(1.5))
      assertEquals("-1.50", formatMemoryDeltaMb(-1.5))
      assertEquals("1.50 MiB", formatMebibytes(1_572_864))
    } finally {
      Locale.setDefault(previous)
    }
  }

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
