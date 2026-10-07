package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import java.io.File
import kotlin.math.abs

/**
 * Pure record/compare logic for overlay renderer screenshot tests, over plain ARGB pixel arrays so
 * it carries no Android or Compose dependency and is unit-tested on its own
 * (`OverlayScreenshotComparatorTest`). PNG encoding/decoding is injected through [PngCodec] so the
 * Robolectric harness can use the platform `Bitmap` codec while the unit tests use an in-memory
 * fake.
 *
 * Tolerances mirror desktop-core's `ScreenshotComparator` (see
 * `android/docs/screenshot-testing.md`): a small per-channel tolerance absorbs anti-aliasing jitter
 * and a tiny differing-pixel ratio keeps real layout/content changes failing. Font rasterization
 * still differs across operating systems, so baselines are pinned to one reference OS by
 * [OverlayScreenshotEnvironment], not here.
 */
internal object OverlayScreenshotComparator {

  /** ARGB pixels in row-major order; `pixels.size == width * height`. */
  class Image(val width: Int, val height: Int, val pixels: IntArray) {
    init {
      require(pixels.size == width * height) {
        "Expected ${width * height} pixels for ${width}x$height, got ${pixels.size}"
      }
    }
  }

  /** Reads and writes [Image]s as PNG files; [write] creates missing parent directories. */
  interface PngCodec {
    /** Returns null when [file] does not exist or does not decode as an image. */
    fun read(file: File): Image?

    fun write(file: File, image: Image)
  }

  data class Options(val channelTolerance: Int = 4, val maxDifferentPixelRatio: Double = 0.001)

  sealed interface Result {
    data object Recorded : Result

    data object Match : Result

    data class MissingBaseline(val baseline: File) : Result

    data class SizeMismatch(
      val expectedWidth: Int,
      val expectedHeight: Int,
      val actualWidth: Int,
      val actualHeight: Int,
      val actualFile: File,
    ) : Result

    data class Mismatch(
      val differentPixelRatio: Double,
      val differentPixelCount: Int,
      val diffFile: File,
      val actualFile: File,
    ) : Result
  }

  fun record(codec: PngCodec, baseline: File, actual: Image): Result {
    codec.write(baseline, actual)
    return Result.Recorded
  }

  /**
   * Compares [actual] with the PNG at [baseline]. On a mismatch the rejected image and a
   * red-highlighted diff are written to [reportDir] so the failure is inspectable.
   */
  fun compare(
    codec: PngCodec,
    baseline: File,
    actual: Image,
    reportDir: File,
    name: String,
    options: Options = Options(),
  ): Result {
    val expected = codec.read(baseline) ?: return Result.MissingBaseline(baseline)
    if (expected.width != actual.width || expected.height != actual.height) {
      return Result.SizeMismatch(
        expected.width,
        expected.height,
        actual.width,
        actual.height,
        writeReport(codec, reportDir, "$name.actual.png", actual),
      )
    }
    val diff = IntArray(actual.pixels.size)
    val differing =
      actual.pixels.indices.count { index ->
        val different =
          pixelsDiffer(expected.pixels[index], actual.pixels[index], options.channelTolerance)
        diff[index] = if (different) HIGHLIGHT else dim(actual.pixels[index])
        different
      }
    val ratio = if (diff.isEmpty()) 0.0 else differing.toDouble() / diff.size
    if (ratio <= options.maxDifferentPixelRatio) return Result.Match
    return Result.Mismatch(
      ratio,
      differing,
      writeReport(codec, reportDir, "$name.diff.png", Image(actual.width, actual.height, diff)),
      writeReport(codec, reportDir, "$name.actual.png", actual),
    )
  }

  private fun pixelsDiffer(a: Int, b: Int, tolerance: Int): Boolean = CHANNEL_SHIFTS.any { shift ->
    abs((a ushr shift and 0xFF) - (b ushr shift and 0xFF)) > tolerance
  }

  /** Desaturated, dimmed copy of a matching pixel so the red diff stands out. */
  private fun dim(argb: Int): Int {
    val average = ((argb ushr 16 and 0xFF) + (argb ushr 8 and 0xFF) + (argb and 0xFF)) / 3
    val gray = (average * 0.35).toInt().coerceIn(0, 255)
    return (0xFF shl 24) or (gray shl 16) or (gray shl 8) or gray
  }

  private fun writeReport(codec: PngCodec, reportDir: File, fileName: String, image: Image): File {
    return File(reportDir, fileName).also { codec.write(it, image) }
  }

  private val CHANNEL_SHIFTS = intArrayOf(24, 16, 8, 0)
  private const val HIGHLIGHT = 0xFFFF0000.toInt()
}
