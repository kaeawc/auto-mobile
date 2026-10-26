package dev.jasonpearson.automobile.prototype

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import java.io.ByteArrayOutputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** #15316: the image row must be laid out with the bundle's bytes, not collapse to zero height. */
@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeBundledImageTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  private fun redPng(): ByteArray {
    val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(Color.rgb(220, 30, 30))
    return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
  }

  @Test
  fun `an unsized bundled image takes its natural height above the following text`() {
    val spec =
      embeddedSpec(
        """{"type":"column","children":[{"type":"image","testTag":"hero","asset":"hero"},{"type":"text","testTag":"caption","text":"below"}]}""",
      )
    val assets = PrototypeAssets(images = mapOf("hero" to redPng()))
    compose.setContent { host.Content { AutoMobilePrototype(spec, assets = assets) } }
    compose.waitForIdle()
    val hero = compose.onNodeWithTag("hero").fetchSemanticsNode().boundsInRoot
    val caption = compose.onNodeWithTag("caption").fetchSemanticsNode().boundsInRoot
    assertEquals("hero height $hero", 96f, hero.height, 0.5f)
    assertTrue("caption $caption hero $hero", caption.top >= hero.bottom)
  }
}
