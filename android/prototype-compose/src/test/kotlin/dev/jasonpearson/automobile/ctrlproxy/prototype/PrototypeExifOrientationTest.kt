package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeExifOrientationTest {
  @Test
  fun `maps all eight EXIF orientations`() {
    val expected =
      listOf(
        PrototypeExifOrientation(0, false),
        PrototypeExifOrientation(0, true),
        PrototypeExifOrientation(180, false),
        PrototypeExifOrientation(180, true),
        PrototypeExifOrientation(90, true),
        PrototypeExifOrientation(90, false),
        PrototypeExifOrientation(270, true),
        PrototypeExifOrientation(270, false),
      )
    expected.forEachIndexed { index, orientation ->
      val tag = index + 1
      val actual = prototypeExifOrientation(tag)
      assertEquals("orientation $tag", orientation, actual)
      assertEquals("swaps axes for $tag", tag >= 5, actual.swapsAxes)
    }
  }

  @Test
  fun `missing and out of range tags use identity`() {
    val identity = PrototypeExifOrientation(0, false)
    assertEquals(identity, prototypeExifOrientation(0))
    assertEquals(identity, prototypeExifOrientation(9))
    assertEquals(identity, prototypeExifOrientation(-1))
  }

  @Test
  fun `quarter turns sample against the target in source axes`() {
    val target = PrototypeImageTarget(1024, 512)
    val quarterTurn = prototypeExifOrientation(6)
    assertEquals(PrototypeImageTarget(512, 1024), quarterTurn.sourceTarget(target))
    assertEquals(target, prototypeExifOrientation(3).sourceTarget(target))
    val maxPixels = 4L * 1024 * 1024
    assertEquals(
      2,
      prototypeImageSampleSize(4096, 2048, quarterTurn.sourceTarget(target), maxPixels),
    )
  }
}
