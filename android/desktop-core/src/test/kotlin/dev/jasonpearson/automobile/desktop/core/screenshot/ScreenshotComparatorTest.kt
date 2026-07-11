package dev.jasonpearson.automobile.desktop.core.screenshot

import java.awt.Color
import java.awt.image.BufferedImage
import java.io.File
import java.nio.file.Files
import javax.imageio.ImageIO
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Pure-logic tests for [ScreenshotComparator]. No Compose, no rendering — these run in well under
 * the module's fast-test budget and never touch a display.
 */
class ScreenshotComparatorTest {

  private val tempDir: File = Files.createTempDirectory("screenshot-comparator").toFile()

  @AfterTest
  fun cleanUp() {
    tempDir.deleteRecursively()
  }

  private fun solid(width: Int, height: Int, color: Color): BufferedImage {
    val image = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
    for (y in 0 until height) for (x in 0 until width) image.setRGB(x, y, color.rgb)
    return image
  }

  @Test
  fun `record writes baseline and creates parent dirs`() {
    val baseline = File(tempDir, "nested/dir/badge.png")
    val result = ScreenshotComparator.record(baseline, solid(4, 4, Color.BLUE))
    assertEquals(ScreenshotComparator.Result.Recorded, result)
    assertTrue(baseline.exists(), "baseline PNG should be written")
    assertEquals(4, ImageIO.read(baseline).width)
  }

  @Test
  fun `identical images match`() {
    val baseline = File(tempDir, "match.png")
    ScreenshotComparator.record(baseline, solid(8, 8, Color.GREEN))
    val result =
      ScreenshotComparator.compare(baseline, solid(8, 8, Color.GREEN), tempDir, "match")
    assertEquals(ScreenshotComparator.Result.Match, result)
  }

  @Test
  fun `small anti-aliasing jitter is tolerated`() {
    val baseline = File(tempDir, "jitter.png")
    ScreenshotComparator.record(baseline, solid(8, 8, Color(100, 100, 100)))
    // Every pixel off by 3 (< default channelTolerance of 4).
    val result =
      ScreenshotComparator.compare(baseline, solid(8, 8, Color(103, 103, 103)), tempDir, "jitter")
    assertEquals(ScreenshotComparator.Result.Match, result)
  }

  @Test
  fun `large color change fails and writes diff plus rejected image`() {
    val baseline = File(tempDir, "diff.png")
    ScreenshotComparator.record(baseline, solid(8, 8, Color.WHITE))
    val result =
      ScreenshotComparator.compare(baseline, solid(8, 8, Color.BLACK), tempDir, "diff")
    assertTrue(result is ScreenshotComparator.Result.Mismatch, "expected a mismatch")
    result as ScreenshotComparator.Result.Mismatch
    assertEquals(1.0, result.differentPixelRatio, "all pixels differ")
    assertTrue(result.diffFile.exists(), "diff image should be written")
    assertTrue(result.actualFile.exists(), "rejected image should be written")
  }

  @Test
  fun `missing baseline is reported`() {
    val result =
      ScreenshotComparator.compare(
        File(tempDir, "does-not-exist.png"),
        solid(2, 2, Color.RED),
        tempDir,
        "missing",
      )
    assertTrue(result is ScreenshotComparator.Result.MissingBaseline)
  }

  @Test
  fun `dimension change is reported as size mismatch`() {
    val baseline = File(tempDir, "size.png")
    ScreenshotComparator.record(baseline, solid(8, 8, Color.GRAY))
    val result =
      ScreenshotComparator.compare(baseline, solid(16, 8, Color.GRAY), tempDir, "size")
    assertTrue(result is ScreenshotComparator.Result.SizeMismatch)
    result as ScreenshotComparator.Result.SizeMismatch
    assertEquals(8, result.expectedWidth)
    assertEquals(16, result.actualWidth)
    assertTrue(result.actualFile.exists())
  }
}
