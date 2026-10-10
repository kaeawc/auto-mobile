package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Robolectric's bitmap shadow cannot model a header that lies about its size (it throws on a bogus
 * PNG), so the rejection of absurd dimensions is covered by `prototypeImageFitsBudget` in
 * [PrototypeImageCacheTest]; this pins that a real image decodes within the pixel budget.
 */
@RunWith(RobolectricTestRunner::class)
class BitmapPrototypeImageDecoderTest {
  @Test
  fun `an oversized image decodes at a size within the pixel budget`() {
    val source = Bitmap.createBitmap(800, 800, Bitmap.Config.ARGB_8888)
    val encoded =
      ByteArrayOutputStream().also { source.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val decoded =
      BitmapPrototypeImageDecoder(maxPixels = 100_000)
        .decode(encoded.toByteArray(), PrototypeImageTarget(100, 100))
    assertNotNull(decoded)
    assertTrue(decoded!!.width.toLong() * decoded.height <= 100_000)
  }
}
