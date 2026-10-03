package dev.jasonpearson.automobile.ide

import java.util.Locale
import kotlin.test.assertEquals
import org.junit.Test

class UiNumberFormattingTest {
  @Test
  fun `numbers follow the user locale with unchanged precision`() {
    val previous = Locale.getDefault(Locale.Category.FORMAT)
    try {
      Locale.setDefault(Locale.Category.FORMAT, Locale.GERMANY)
      assertEquals("1,5", formatUiNumber("%.1f", 1.5))
      assertEquals("1,50", formatUiNumber("%.2f", 1.5))
      assertEquals("2", formatUiNumber("%.0f", 1.5))
      assertEquals("1.05s", formatUiNumber("%d.%02ds", 1, 5))
      assertEquals("1:02.05", formatUiNumber("%d:%02d.%02d", 1, 2, 5))
    } finally {
      Locale.setDefault(Locale.Category.FORMAT, previous)
    }
  }

  @Test
  fun `FORMAT locale wins over the general default`() {
    val previousDefault = Locale.getDefault()
    val previousFormat = Locale.getDefault(Locale.Category.FORMAT)
    try {
      Locale.setDefault(Locale.US)
      Locale.setDefault(Locale.Category.FORMAT, Locale.GERMANY)
      assertEquals("1,5", formatUiNumber("%.1f", 1.5))
    } finally {
      Locale.setDefault(previousDefault)
      Locale.setDefault(Locale.Category.FORMAT, previousFormat)
    }
  }
}
