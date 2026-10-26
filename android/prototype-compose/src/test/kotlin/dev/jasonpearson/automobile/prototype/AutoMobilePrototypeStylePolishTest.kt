package dev.jasonpearson.automobile.prototype

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidColorFilter
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeContinuousPath
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeImageColorFilter
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeImageTintFilter
import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
// Exercise real graphics rather than the module default API 24 legacy graphics.
@Config(sdk = [28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AutoMobilePrototypeStylePolishTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  private lateinit var photo: ByteArray

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @Before
  fun preparePhoto() {
    val bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(android.graphics.Color.RED)
    photo =
      ByteArrayOutputStream()
        .also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        .toByteArray()
    bitmap.recycle()
  }

  @After fun close() = host.close()

  @Test
  fun `style polish corpus fixture renders without crashing`() {
    val input = fixtureFile("prototype-spec/valid").resolve("theme-modes-style-polish-v2.json").readText()
    render(input)
  }

  @Test
  fun `base style renders continuous corners and extreme shadow layers`() {
    val input = fixtureFile("prototype-spec/valid").resolve("theme-modes-style-polish-v2.json").readText()
    val document = Json.parseToJsonElement(input).jsonObject
    render(
      JsonObject(document + ("state" to JsonObject(mapOf("active" to JsonPrimitive(false)))))
        .toString(),
    )
  }

  private fun render(input: String) {
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          assets = PrototypeAssets(images = mapOf("photo" to photo)),
          storage = FakePrototypeStorage(),
          network = PrototypeNetwork(FakePrototypeHttp()),
          onError = { error("Style polish fixture failed to load: $it") },
        )
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `saturation clamps before tint modulation`() {
    val source = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    val target = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    val saturated = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    try {
      source.setPixel(0, 0, android.graphics.Color.rgb(255, 51, 51))
      val saturationPaint =
        Paint().apply {
          colorFilter = prototypeImageColorFilter(2.0).asAndroidColorFilter()
        }
      Canvas(saturated).drawBitmap(source, 0f, 0f, saturationPaint)
      val tintPaint =
        Paint().apply {
          colorFilter = prototypeImageTintFilter(Color(0.5f, 1f, 1f)).asAndroidColorFilter()
        }
      Canvas(target).drawBitmap(saturated, 0f, 0f, tintPaint)
      // Saturation produces red > 1; it must clamp to 1 before the tint halves it.
      val red = android.graphics.Color.red(target.getPixel(0, 0))
      assertTrue("Red channel after saturation then tint: $red", red in 127..128)
    } finally {
      source.recycle()
      target.recycle()
      saturated.recycle()
    }
  }

  @Test
  fun `native continuous paths stay finite and within their bounds`() {
    for (size in listOf(Size(200f, 100f), Size(100f, 100f))) {
      val cases =
        listOf(0f, 8f, 50f, 9999f).map { radius -> List(4) { CornerRadius(radius) } } +
          listOf(listOf(8f, 16f, 9999f, 0f).map { CornerRadius(it) })
      for (radii in cases) {
        val bounds = prototypeContinuousPath(size, radii).getBounds()
        assertTrue(bounds.left.isFinite() && bounds.top.isFinite())
        assertTrue(bounds.right.isFinite() && bounds.bottom.isFinite())
        assertEquals(0f, bounds.left, 0.001f)
        assertEquals(0f, bounds.top, 0.001f)
        assertEquals(size.width, bounds.right, 0.001f)
        assertEquals(size.height, bounds.bottom, 0.001f)
      }
    }
  }
}
