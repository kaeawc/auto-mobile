package dev.jasonpearson.automobile.ctrlproxy.prototype

/** The size, in pixels, an image will be shown at; the decoder downsamples to at least this. */
@InternalAutoMobilePrototypeApi data class PrototypeImageTarget(val widthPx: Int, val heightPx: Int)

/**
 * The `inSampleSize` for decoding a [sourceWidth]x[sourceHeight] image for [target]: the largest
 * power of two that keeps both decoded dimensions at least the target's, then larger still while
 * the decoded pixel count would exceed [maxPixels]. A downsampled bitmap is never smaller than the
 * target unless the pixel cap forces it.
 */
internal fun prototypeImageSampleSize(
  sourceWidth: Int,
  sourceHeight: Int,
  target: PrototypeImageTarget,
  maxPixels: Long,
): Int {
  var sample = 1
  while (sample < MAX_SAMPLE_SIZE) {
    val width = sourceWidth / sample
    val height = sourceHeight / sample
    val halvable = width / 2 >= target.widthPx && height / 2 >= target.heightPx
    val tooBig = !prototypeImageFitsBudget(sourceWidth, sourceHeight, sample, maxPixels)
    if (!halvable && !tooBig) break
    sample = sample shl 1
  }
  return sample
}

/** Whether decoding at [sampleSize] stays within [maxPixels]; false for absurd header sizes. */
internal fun prototypeImageFitsBudget(
  sourceWidth: Int,
  sourceHeight: Int,
  sampleSize: Int,
  maxPixels: Long,
): Boolean {
  if (sourceWidth !in 1..MAX_SOURCE_DIMENSION || sourceHeight !in 1..MAX_SOURCE_DIMENSION)
    return false
  if (sampleSize <= 0 || maxPixels <= 0) return false
  // Round up: codecs may produce the partial last row/column instead of truncating it.
  val width = (sourceWidth.toLong() + sampleSize - 1) / sampleSize
  val height = (sourceHeight.toLong() + sampleSize - 1) / sampleSize
  return width * height <= maxPixels
}

/**
 * Divide the byte budget before multiplying dimensions, avoiding Long overflow for hostile headers.
 */
internal fun prototypeImagePixelBudget(maxPixels: Long, maxBytes: Long, bytesPerPixel: Int): Long {
  require(bytesPerPixel > 0)
  return minOf(maxPixels, maxBytes / bytesPerPixel)
}

/**
 * EXIF's eight transforms as a row-major Android Matrix, with translation supplied by createBitmap.
 */
internal fun prototypeImageOrientationMatrix(orientation: Int): List<Float> {
  val linear =
    when (orientation) {
      2 -> listOf(-1f, 0f, 0f, 1f) // Mirror horizontally.
      3 -> listOf(-1f, 0f, 0f, -1f)
      4 -> listOf(1f, 0f, 0f, -1f) // Mirror vertically.
      5 -> listOf(0f, 1f, 1f, 0f) // Transpose.
      6 -> listOf(0f, -1f, 1f, 0f) // 90 degrees clockwise.
      7 -> listOf(0f, -1f, -1f, 0f) // Transverse.
      8 -> listOf(0f, 1f, -1f, 0f) // 270 degrees clockwise.
      else -> listOf(1f, 0f, 0f, 1f)
    }
  return listOf(linear[0], linear[1], 0f, linear[2], linear[3], 0f, 0f, 0f, 1f)
}

// Bound each axis independently, including hostile very-wide, one-row images.
private const val MAX_SOURCE_DIMENSION = 1 shl 16

private const val MAX_SAMPLE_SIZE = 1 shl 6
