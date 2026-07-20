package dev.jasonpearson.automobile.desktop.core.screenshot

import java.awt.Color
import java.awt.RenderingHints
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

  /**
   * A premultiplied-alpha capture with anti-aliased, partially transparent pixels — what
   * `captureToImage().toAwtImage()` produces for real Compose content, as opposed to the solid
   * fills the other cases use.
   */
  private fun premultipliedAntiAliasedCapture(width: Int, height: Int): BufferedImage {
    val image = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB_PRE)
    for (y in 0 until height) for (x in 0 until width) {
      // Diagonal alpha ramp so most pixels are partially transparent, where a lossy
      // premultiply/unpremultiply round-trip would show up.
      val alpha = ((x + y) * 255 / (width + height)).coerceIn(0, 255)
      image.setRGB(x, y, Color(20 + x % 200, 200 - y % 200, (x * y) % 256, alpha).rgb)
    }
    val g = image.createGraphics()
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
    g.color = Color(255, 255, 255, 180)
    g.drawLine(0, 0, width - 1, height - 1)
    g.dispose()
    return image
  }

  /**
   * Recording a baseline and immediately verifying the *same* capture against it must report
   * [ScreenshotComparator.Result.Match] — i.e. the PNG round-trip `record` performs is lossless as
   * far as [ScreenshotComparator.compare] is concerned.
   *
   * This pins the record→verify half of the reproducibility question for issue #3913: `compare`
   * reads the baseline back through `ImageIO` while `actual` is the raw in-memory capture, so an
   * asymmetric round-trip here would make every recorded baseline fail its own verification. It
   * does not — which is what rules the comparator out as the cause of that failure and points at
   * the render step instead.
   */
  @Test
  fun `recording then verifying the same anti-aliased capture matches`() {
    val captured = premultipliedAntiAliasedCapture(200, 100)
    val baseline = File(tempDir, "anti_aliased.png")

    ScreenshotComparator.record(baseline, captured)

    assertEquals(
      ScreenshotComparator.Result.Match,
      ScreenshotComparator.compare(baseline, captured, tempDir, "anti_aliased"),
      "a freshly recorded baseline must verify against the capture it was recorded from",
    )
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
    val result = ScreenshotComparator.compare(baseline, solid(8, 8, Color.GREEN), tempDir, "match")
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
    val result = ScreenshotComparator.compare(baseline, solid(8, 8, Color.BLACK), tempDir, "diff")
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
    val result = ScreenshotComparator.compare(baseline, solid(16, 8, Color.GRAY), tempDir, "size")
    assertTrue(result is ScreenshotComparator.Result.SizeMismatch)
    result as ScreenshotComparator.Result.SizeMismatch
    assertEquals(8, result.expectedWidth)
    assertEquals(16, result.actualWidth)
    assertTrue(result.actualFile.exists())
  }
}
