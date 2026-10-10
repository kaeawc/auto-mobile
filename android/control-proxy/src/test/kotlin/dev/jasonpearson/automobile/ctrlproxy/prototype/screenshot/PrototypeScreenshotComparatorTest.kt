package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot.OverlayScreenshotComparator.Image
import dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot.OverlayScreenshotComparator.Result
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayScreenshotComparatorTest {
  /** In-memory PNG store: the comparator only needs read/write by path. */
  private class FakePngCodec : OverlayScreenshotComparator.PngCodec {
    val files = mutableMapOf<String, Image>()

    override fun read(file: File): Image? = files[file.path]

    override fun write(file: File, image: Image) {
      files[file.path] = image
    }
  }

  private val codec = FakePngCodec()
  private val reportDir = File("reports")
  private val baseline = File("golden/panel.png")

  private fun solid(argb: Int, width: Int = 10, height: Int = 10) =
    Image(width, height, IntArray(width * height) { argb })

  private fun compare(actual: Image, options: OverlayScreenshotComparator.Options) =
    OverlayScreenshotComparator.compare(codec, baseline, actual, reportDir, "panel", options)

  private fun compare(actual: Image) = compare(actual, OverlayScreenshotComparator.Options())

  @Test
  fun `a missing baseline is reported, never treated as a match`() {
    assertEquals(Result.MissingBaseline(baseline), compare(solid(WHITE)))
  }

  @Test
  fun `a recorded baseline matches the same image`() {
    OverlayScreenshotComparator.record(codec, baseline, solid(WHITE))
    assertEquals(Result.Match, compare(solid(WHITE)))
  }

  @Test
  fun `channel differences within tolerance match`() {
    OverlayScreenshotComparator.record(codec, baseline, solid(0xFF808080.toInt()))
    assertEquals(Result.Match, compare(solid(0xFF848484.toInt())))
  }

  @Test
  fun `a size change reports both sizes and keeps the rejected image`() {
    OverlayScreenshotComparator.record(codec, baseline, solid(WHITE))
    val result = compare(solid(WHITE, width = 12))
    assertEquals(
      Result.SizeMismatch(10, 10, 12, 10, File(reportDir, "panel.actual.png")),
      result,
    )
    assertEquals(12, codec.files[File(reportDir, "panel.actual.png").path]?.width)
  }

  @Test
  fun `differing pixels beyond the ratio fail with a highlighted diff`() {
    OverlayScreenshotComparator.record(codec, baseline, solid(WHITE))
    val actual =
      solid(WHITE).also {
        it.pixels[0] = BLACK
        it.pixels[1] = BLACK
      }
    val result = compare(actual)
    assertTrue(result is Result.Mismatch)
    result as Result.Mismatch
    assertEquals(2, result.differentPixelCount)
    assertEquals(0.02, result.differentPixelRatio, 1e-9)
    val diff = checkNotNull(codec.files[result.diffFile.path])
    assertEquals(0xFFFF0000.toInt(), diff.pixels[0])
    assertTrue(diff.pixels[2] != 0xFFFF0000.toInt())
  }

  @Test
  fun `an alpha-only change counts as a difference`() {
    OverlayScreenshotComparator.record(codec, baseline, solid(WHITE))
    val result = compare(solid(0x00FFFFFF), OverlayScreenshotComparator.Options())
    assertTrue(result is Result.Mismatch)
  }

  @Test
  fun `the differing-pixel ratio is inclusive`() {
    OverlayScreenshotComparator.record(codec, baseline, solid(WHITE))
    val actual = solid(WHITE).also { it.pixels[0] = BLACK }
    assertEquals(
      Result.Match,
      compare(actual, OverlayScreenshotComparator.Options(maxDifferentPixelRatio = 0.01)),
    )
  }

  private companion object {
    const val WHITE = 0xFFFFFFFF.toInt()
    const val BLACK = 0xFF000000.toInt()
  }
}
