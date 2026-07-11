package dev.jasonpearson.automobile.desktop.core.screenshot

import java.awt.Color
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.abs

/**
 * Pure image record/compare logic for desktop screenshot tests. Deliberately free of any Compose
 * dependency so it is fast to unit test on its own (see `ScreenshotComparatorTest`).
 *
 * Comparison is tolerant of tiny anti-aliasing differences via [Options.channelTolerance] and
 * [Options.maxDifferentPixelRatio]; see the defaults for the rationale. Font rasterization still
 * differs across operating systems, so baselines are pinned to a single reference OS — that gating
 * lives in [ScreenshotEnvironment], not here.
 */
object ScreenshotComparator {

  /**
   * @param channelTolerance Per-channel (ARGB) absolute difference, 0-255, below which two pixels
   *   are considered equal. A small value absorbs sub-pixel anti-aliasing jitter without hiding
   *   real color changes.
   * @param maxDifferentPixelRatio Fraction of differing pixels (0.0-1.0) tolerated before the
   *   comparison fails. Kept very small so genuine layout/content changes are still caught.
   */
  data class Options(
    val channelTolerance: Int = 4,
    val maxDifferentPixelRatio: Double = 0.001,
  )

  sealed interface Result {
    /** The baseline was (re)written; nothing was compared. */
    data object Recorded : Result

    /** Actual image matched the baseline within tolerance. */
    data object Match : Result

    /** No baseline exists yet; record one before it can be verified. */
    data class MissingBaseline(val baseline: File) : Result

    /** Actual and baseline dimensions differ; a full pixel diff is not meaningful. */
    data class SizeMismatch(
      val expectedWidth: Int,
      val expectedHeight: Int,
      val actualWidth: Int,
      val actualHeight: Int,
      val actualFile: File,
    ) : Result

    /** Dimensions matched but too many pixels differ. */
    data class Mismatch(
      val differentPixelRatio: Double,
      val differentPixelCount: Int,
      val diffFile: File,
      val actualFile: File,
    ) : Result
  }

  /** Writes [actual] to [baseline], creating parent directories as needed. */
  fun record(baseline: File, actual: BufferedImage): Result {
    baseline.parentFile?.mkdirs()
    ImageIO.write(actual, "png", baseline)
    return Result.Recorded
  }

  /**
   * Compares [actual] against the PNG at [baseline]. On mismatch, writes the rejected image and a
   * red-highlighted diff into [reportDir] so failures are inspectable.
   */
  fun compare(
    baseline: File,
    actual: BufferedImage,
    reportDir: File,
    name: String,
    options: Options = Options(),
  ): Result {
    if (!baseline.exists()) return Result.MissingBaseline(baseline)
    val expected = ImageIO.read(baseline) ?: return Result.MissingBaseline(baseline)

    if (expected.width != actual.width || expected.height != actual.height) {
      return Result.SizeMismatch(
        expectedWidth = expected.width,
        expectedHeight = expected.height,
        actualWidth = actual.width,
        actualHeight = actual.height,
        actualFile = writeReport(reportDir, "$name.actual.png", actual),
      )
    }

    val diff = BufferedImage(expected.width, expected.height, BufferedImage.TYPE_INT_ARGB)
    var differing = 0
    for (y in 0 until expected.height) {
      for (x in 0 until expected.width) {
        val e = Color(expected.getRGB(x, y), true)
        val a = Color(actual.getRGB(x, y), true)
        if (pixelsDiffer(e, a, options.channelTolerance)) {
          differing++
          diff.setRGB(x, y, HIGHLIGHT)
        } else {
          diff.setRGB(x, y, dim(a))
        }
      }
    }

    val total = expected.width.toLong() * expected.height.toLong()
    val ratio = if (total == 0L) 0.0 else differing.toDouble() / total.toDouble()
    if (ratio > options.maxDifferentPixelRatio) {
      return Result.Mismatch(
        differentPixelRatio = ratio,
        differentPixelCount = differing,
        diffFile = writeReport(reportDir, "$name.diff.png", diff),
        actualFile = writeReport(reportDir, "$name.actual.png", actual),
      )
    }
    return Result.Match
  }

  private fun pixelsDiffer(a: Color, b: Color, tolerance: Int): Boolean =
    abs(a.red - b.red) > tolerance ||
      abs(a.green - b.green) > tolerance ||
      abs(a.blue - b.blue) > tolerance ||
      abs(a.alpha - b.alpha) > tolerance

  /** Desaturated, dimmed version of a matching pixel so the red diff stands out. */
  private fun dim(c: Color): Int {
    val gray = ((c.red + c.green + c.blue) / 3 * 0.35).toInt().coerceIn(0, 255)
    return Color(gray, gray, gray, 255).rgb
  }

  private fun writeReport(reportDir: File, fileName: String, image: BufferedImage): File {
    reportDir.mkdirs()
    val file = File(reportDir, fileName)
    ImageIO.write(image, "png", file)
    return file
  }

  private val HIGHLIGHT = Color(255, 0, 0, 255).rgb
}
