package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * A generated large PNG exercises the bounds pass and sampled decode. Hostile dimensions and
 * high-bit-depth sizing are covered without bitmap allocations in [PrototypeImageDecodingTest].
 */
@RunWith(RobolectricTestRunner::class)
class BitmapPrototypeImageDecoderTest {
  @get:Rule val temp = TemporaryFolder()

  @Test
  fun `an oversized image decodes at a size within the pixel budget`() {
    val decoded =
      BitmapPrototypeImageDecoder(maxPixels = 100_000)
        .decode(encoded, PrototypeImageTarget(100, 100))
    assertNotNull(decoded)
    assertTrue(decoded!!.width.toLong() * decoded.height <= 100_000)
    assertTrue(decoded.byteCount <= BitmapPrototypeImageDecoder.DEFAULT_MAX_DECODED_BYTES)
  }

  @Test
  fun `byte budget forces sampling even when the pixel limit and display target allow full size`() {
    val decoded =
      BitmapPrototypeImageDecoder(maxPixels = Long.MAX_VALUE, maxDecodedBytes = 64 * 1024)
        .decode(encoded, PrototypeImageTarget(4096, 2048))
    assertNotNull(decoded)
    assertTrue(decoded!!.byteCount <= 64 * 1024)
  }

  @Test
  fun `EXIF orientation six rotates the sampled JPEG`() {
    val decoded =
      requireNotNull(
        BitmapPrototypeImageDecoder(maxPixels = 1000)
          .decode(jpeg(ExifInterface.ORIENTATION_ROTATE_90), PrototypeImageTarget(24, 16)),
      )
    assertEquals(16, decoded.width)
    assertEquals(24, decoded.height)
  }

  @Test
  fun `EXIF orientations five to eight choose the sample size for the swapped target`() {
    // Stored 4096x2048, displayed 2048x4096. Sampling against the swapped 512x1024 target gives
    // 2; the unswapped 1024x512 target would allow 4 and decode a 512x1024 bitmap.
    val decoded =
      requireNotNull(
        largeDecoder.decode(
          jpeg(ExifInterface.ORIENTATION_ROTATE_90, width = 4096, height = 2048),
          PrototypeImageTarget(1024, 512),
        ),
      )
    assertEquals(1024, decoded.width)
    assertEquals(2048, decoded.height)
  }

  @Test
  fun `EXIF orientation one samples against the unswapped target`() {
    val decoded =
      requireNotNull(
        largeDecoder.decode(
          jpeg(ExifInterface.ORIENTATION_NORMAL, width = 4096, height = 2048),
          PrototypeImageTarget(1024, 512),
        ),
      )
    assertEquals(1024, decoded.width)
    assertEquals(512, decoded.height)
  }

  /** Budgets high enough that only the display target drives sample-size selection. */
  private val largeDecoder =
    BitmapPrototypeImageDecoder(maxPixels = Long.MAX_VALUE, maxDecodedBytes = Long.MAX_VALUE)

  @Test
  fun `an EXIF transform samples further so the source and its copy share the pixel budget`() {
    val target = PrototypeImageTarget(24, 16)
    val upright =
      requireNotNull(
        BitmapPrototypeImageDecoder(maxPixels = 500)
          .decode(jpeg(ExifInterface.ORIENTATION_NORMAL), target),
      )
    assertEquals(24 * 16, upright.width * upright.height)

    val rotated =
      requireNotNull(
        BitmapPrototypeImageDecoder(maxPixels = 500)
          .decode(jpeg(ExifInterface.ORIENTATION_ROTATE_90), target),
      )
    assertEquals(8, rotated.width)
    assertEquals(12, rotated.height)
  }

  /** A [width]x[height] (48x32 by default) JPEG tagged with EXIF [orientation]. */
  private fun jpeg(orientation: Int, width: Int = 48, height: Int = 32): ByteArray {
    val file = temp.newFile()
    val source = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    file.outputStream().use { assertTrue(source.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
    source.recycle()
    ExifInterface(file.path).apply {
      setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
      saveAttributes()
    }
    return file.readBytes()
  }

  companion object {
    private lateinit var encoded: ByteArray

    @JvmStatic
    @BeforeClass
    fun generateLargeImage() {
      // Generate, rather than check in, an image much bigger than the decoder's output budget.
      val source = Bitmap.createBitmap(4096, 2048, Bitmap.Config.ARGB_8888)
      encoded =
        ByteArrayOutputStream()
          .also {
            source.compress(Bitmap.CompressFormat.PNG, 100, it)
          }
          .toByteArray()
      source.recycle()
    }
  }
}
