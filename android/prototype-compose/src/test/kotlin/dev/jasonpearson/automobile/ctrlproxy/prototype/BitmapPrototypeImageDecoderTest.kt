package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import android.media.ExifInterface
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Robolectric's bitmap shadow cannot model a header that lies about its size (it throws on a bogus
 * PNG), so the rejection of absurd dimensions is covered by `prototypeImageFitsBudget` in
 * [PrototypeImageCacheTest]; this pins that a real image decodes within the pixel budget.
 */
@RunWith(RobolectricTestRunner::class)
class BitmapPrototypeImageDecoderTest {
  @get:Rule val temp = TemporaryFolder()

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

  @Test
  fun `EXIF orientation six rotates the sampled JPEG`() {
    val jpeg = temp.newFile("orientation.jpg")
    val source = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888)
    jpeg.outputStream().use { assertTrue(source.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
    ExifInterface(jpeg.path).apply {
      setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
      saveAttributes()
    }

    val decoded =
      requireNotNull(
        BitmapPrototypeImageDecoder(maxPixels = 500)
          .decode(jpeg.readBytes(), PrototypeImageTarget(24, 16)),
      )
    assertEquals(16, decoded.width)
    assertEquals(24, decoded.height)
  }
}
