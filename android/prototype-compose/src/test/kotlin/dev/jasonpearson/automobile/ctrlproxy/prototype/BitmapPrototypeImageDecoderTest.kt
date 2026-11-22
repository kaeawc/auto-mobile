package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * A generated large PNG exercises the bounds pass and sampled decode. Hostile dimensions and
 * high-bit-depth sizing are covered without bitmap allocations in [PrototypeImageDecodingTest].
 */
@RunWith(RobolectricTestRunner::class)
class BitmapPrototypeImageDecoderTest {
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
