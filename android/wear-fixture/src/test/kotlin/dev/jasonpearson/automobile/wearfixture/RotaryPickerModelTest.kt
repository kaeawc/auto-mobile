package dev.jasonpearson.automobile.wearfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RotaryPickerModelTest {
  private val model = RotaryPickerModel(valueCount = 12)

  @Test
  fun `small rotations accumulate until one full step`() {
    val partial = model.onRotary(20f).onRotary(20f)
    assertEquals(0, partial.index)
    assertEquals(40f, partial.pendingPixels, 0f)
    val stepped = partial.onRotary(10f)
    assertEquals(1, stepped.index)
    assertEquals(2f, stepped.pendingPixels, 0f)
  }

  @Test
  fun `a large rotation moves several values and reverse rotation moves back`() {
    val forward = model.onRotary(48f * 3)
    assertEquals(3, forward.index)
    assertEquals(1, forward.onRotary(-48f * 2).index)
  }

  @Test
  fun `clamps at both ends and drops the leftover so reversing responds at once`() {
    val start = model.onRotary(-500f)
    assertEquals(0, start.index)
    assertEquals(0f, start.pendingPixels, 0f)
    val end = model.onRotary(48f * 40)
    assertEquals(11, end.index)
    assertEquals(10, end.onRotary(-48f).index)
  }

  @Test
  fun `rejects an empty value list or an out-of-range index`() {
    assertThrows(IllegalArgumentException::class.java) { RotaryPickerModel(valueCount = 0) }
    assertThrows(IllegalArgumentException::class.java) {
      RotaryPickerModel(valueCount = 3, index = 3)
    }
  }
}
