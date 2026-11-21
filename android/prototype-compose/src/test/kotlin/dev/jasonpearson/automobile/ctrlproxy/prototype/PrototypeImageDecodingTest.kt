package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

/** Pure sizing and EXIF math: no Android runtime, image allocations, I/O or timers. */
class PrototypeImageDecodingTest {
  @Test
  fun `eight byte pixels need more sampling than four byte pixels at the same byte limit`() {
    val target = PrototypeImageTarget(4096, 4096)
    val bytes = 16L * 1024 * 1024
    val argb = prototypeImagePixelBudget(Long.MAX_VALUE, bytes, 4)
    val f16 = prototypeImagePixelBudget(Long.MAX_VALUE, bytes, 8)
    assertEquals(4_194_304L, argb)
    assertEquals(2_097_152L, f16)
    assertEquals(2, prototypeImageSampleSize(4096, 4096, target, argb))
    assertEquals(4, prototypeImageSampleSize(4096, 4096, target, f16))
    assertFalse(prototypeImageFitsBudget(4096, 4096, 2, f16))
    assertTrue(prototypeImageFitsBudget(4096, 4096, 4, f16))
  }

  @Test
  fun `invalid and absurd dimensions cannot pass the decode preflight`() {
    val budget = prototypeImagePixelBudget(Long.MAX_VALUE, 16L * 1024 * 1024, 8)
    for ((width, height) in
      listOf(
        0 to 10,
        65537 to 1,
        10 to 0,
        -1 to 10,
        Int.MAX_VALUE to Int.MAX_VALUE,
        Int.MAX_VALUE to 1,
        1 to Int.MAX_VALUE,
      )) {
      val sample = prototypeImageSampleSize(width, height, PrototypeImageTarget(1, 1), budget)
      assertFalse("$width x $height", prototypeImageFitsBudget(width, height, sample, budget))
    }
    assertFalse(prototypeImageFitsBudget(1, 1, 64, 0))
    // A partial edge pixel must count toward the allocation.
    assertFalse(prototypeImageFitsBudget(2049, 2049, 2, 1024L * 1024))
  }

  @Test
  fun `EXIF orientations map asymmetric corners through all rotations and reflections`() {
    // The image-coordinate transform of (2, 3), before createBitmap translates the bounds.
    val expected =
      listOf(
        2f to 3f,
        -2f to 3f,
        -2f to -3f,
        2f to -3f,
        3f to 2f,
        -3f to 2f,
        -3f to -2f,
        3f to -2f,
      )
    for (orientation in 1..8) {
      val m = prototypeImageOrientationMatrix(orientation)
      assertEquals(
        expected[orientation - 1],
        (m[0] * 2 + m[1] * 3) to (m[3] * 2 + m[4] * 3),
      )
      assertEquals(listOf(0f, 0f, 0f, 0f, 1f), listOf(m[2], m[5], m[6], m[7], m[8]))
    }
    assertEquals(prototypeImageOrientationMatrix(1), prototypeImageOrientationMatrix(0))
    assertEquals(prototypeImageOrientationMatrix(1), prototypeImageOrientationMatrix(99))
  }
}
