package dev.jasonpearson.automobile.discover

import dev.jasonpearson.automobile.discover.ui.calculateGridHeightPx
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReorderableGridHeightTest {
  @Test
  fun `phone width fits two rows of 328 pixel cells`() {
    assertEquals(728, calculateGridHeightPx(1080, 6, 3, 24))
  }

  @Test
  fun `foldable inner panel fits two rows of 640 pixel cells`() {
    assertEquals(1340, calculateGridHeightPx(2000, 6, 3, 20))
  }

  @Test
  fun `zero items retain only the content padding`() {
    assertEquals(48, calculateGridHeightPx(1080, 0, 3, 24))
  }

  @Test
  fun `uneven width rounds up to 329 pixel cells without clipping the last row`() {
    val height = calculateGridHeightPx(1081, 6, 3, 24)
    assertEquals(730, height)
    // Flooring to 328 pixel cells would yield 728 and clip the widest measured column.
    assertNotEquals(728, height)
    assertTrue(height >= 730)
  }

  @Test
  fun `spacing consistently affects cell width gaps and padding`() {
    val smallerSpacingHeight = calculateGridHeightPx(1080, 6, 3, 12)
    val largerSpacingHeight = calculateGridHeightPx(1080, 6, 3, 24)
    assertEquals(724, smallerSpacingHeight)
    assertEquals(728, largerSpacingHeight)
    assertTrue(largerSpacingHeight > smallerSpacingHeight)
  }

  @Test
  fun `single row and partial last row retain their full height`() {
    assertEquals(376, calculateGridHeightPx(1080, 3, 3, 24))
    assertEquals(728, calculateGridHeightPx(1080, 4, 3, 24))
  }
}
