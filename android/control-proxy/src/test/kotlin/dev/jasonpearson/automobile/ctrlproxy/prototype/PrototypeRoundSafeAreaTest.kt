package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeRoundSafeAreaTest {
  @Test
  fun `rectangular displays retain zero extra inset`() {
    for ((width, height) in listOf(384 to 384, 1080 to 2400, 2400 to 1080)) {
      assertEquals(PrototypeRoundSafeArea(), prototypeRoundSafeArea(width, height, false))
    }
  }

  @Test
  fun `384 pixel watch moves the complete close target inside the circle`() {
    val safe = prototypeRoundSafeArea(384, 384, true)
    assertEquals(PrototypeRoundSafeArea(57, 57), safe)
    // Top-end 48px target: the outer top-right corner was (384, 0).
    assertCornersInside(384 to 384, 384 - safe.horizontal - 48, safe.vertical, 48, 48)
  }

  @Test
  fun `all safe square corners fit odd even and non square displays`() {
    for ((width, height) in listOf(383 to 383, 384 to 384, 385 to 385, 400 to 384, 384 to 400)) {
      val safe = prototypeRoundSafeArea(width, height, true)
      assertCornersInside(
        width to height,
        safe.horizontal,
        safe.vertical,
        width - 2 * safe.horizontal,
        height - 2 * safe.vertical,
      )
    }
  }

  @Test
  fun `inward rounding excludes the immediately smaller unsafe inset`() {
    val safe = prototypeRoundSafeArea(384, 384, true)
    val cornerDistance = 192.0 - (safe.horizontal - 1)
    assertTrue(2 * cornerDistance * cornerDistance > 192.0 * 192.0)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `invalid display bounds are rejected`() {
    prototypeRoundSafeArea(0, 384, true)
  }

  private fun assertCornersInside(
    display: Pair<Int, Int>,
    left: Int,
    top: Int,
    width: Int,
    height: Int,
  ) {
    val (displayWidth, displayHeight) = display
    val radius = minOf(displayWidth, displayHeight) / 2.0
    for (x in listOf(left, left + width)) {
      for (y in listOf(top, top + height)) {
        val dx = x - displayWidth / 2.0
        val dy = y - displayHeight / 2.0
        assertTrue("Corner ($x, $y) must fit", dx * dx + dy * dy <= radius * radius)
      }
    }
  }
}
