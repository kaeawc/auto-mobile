package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class PrototypeRemoteImageRenderingTest {
  @get:Rule val compose = createComposeRule()
  private val activity = PrototypeRemoteImageActivity()

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun node(placeholder: JsonObject, error: JsonObject? = null): PrototypeRenderNode =
    mapPrototypeSpec(
        PrototypeSpec(
          "image",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          emptyMap(),
          PrototypeImageNode(
            url = "https://images.example/private-token",
            testTag = "image",
            contentDescription = "Profile",
            semantics = PrototypeSemantics(hint = "Profile picture"),
            placeholder = placeholder,
            error = error,
            crossfade = true,
            style =
              PrototypeStyle(
                width = PrototypeDimension.Dp(40.0),
                height = PrototypeDimension.Dp(40.0),
              ),
          ),
        ),
      )
      .root

  @Test
  fun `color placeholder becomes loaded pixels with reduced motion and private semantics`() {
    val answer = CompletableDeferred<PrototypeImageState>()
    val loader = PrototypeRemoteImageLoader { _, _ -> answer.await() }
    val image =
      Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888).apply {
        eraseColor(android.graphics.Color.BLUE)
      }
    val node = node(JsonObject(mapOf("color" to JsonPrimitive("#ff0000"))))
    compose.setContent {
      MaterialTheme {
        CompositionLocalProvider(
          LocalPrototypeRemoteImages provides loader,
          LocalPrototypeRemoteImageActivity provides activity,
          LocalPrototypeMotion provides false,
        ) {
          PrototypeSpecContent(node)
        }
      }
    }
    assertState("loading")
    assertPixel(Color.Red)
    assertEquals(PrototypeRemoteImageCounts(pending = 1), activity.counts())
    compose.runOnIdle { answer.complete(PrototypeImageState.Ready(BitmapPrototypeImage(image))) }
    assertState("loaded")
    assertPixel(Color.Blue)
    assertEquals(PrototypeRemoteImageCounts(loaded = 1), activity.counts())
    val semantics = compose.onNodeWithTag("image").fetchSemanticsNode().config
    assertFalse(semantics.toString().contains("https://"))
  }

  @Test
  fun `asset placeholder is drawn until failure selects the authored error color`() {
    val answer = CompletableDeferred<PrototypeImageState>()
    val loader = PrototypeRemoteImageLoader { _, _ -> answer.await() }
    val bitmap =
      Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888).apply {
        eraseColor(android.graphics.Color.GREEN)
      }
    val bytes =
      ByteArrayOutputStream()
        .also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        .toByteArray()
    val source =
      object : PrototypeAssetSource {
        override fun lookup(id: String) = PrototypeAssetInfo(id, "image/png", bytes.size)

        override fun read(id: String) = bytes

        override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
      }
    val cache =
      PrototypeImageCache(
        source,
        { _, _ -> BitmapPrototypeImage(bitmap) },
        dispatcher = UnconfinedTestDispatcher(),
      )
    val node =
      node(
        JsonObject(mapOf("asset" to JsonPrimitive("loading"))),
        JsonObject(mapOf("color" to JsonPrimitive("#ff0000"))),
      )
    compose.setContent {
      MaterialTheme {
        CompositionLocalProvider(
          LocalPrototypeImageCache provides cache,
          LocalPrototypeRemoteImages provides loader,
          LocalPrototypeRemoteImageActivity provides activity,
          LocalPrototypeMotion provides false,
        ) {
          PrototypeSpecContent(node)
        }
      }
    }
    assertState("loading")
    assertPixel(Color.Green)
    compose.runOnIdle { answer.complete(PrototypeImageState.Missing) }
    assertState("error")
    assertPixel(Color.Red)
    assertEquals(PrototypeRemoteImageCounts(failed = 1), activity.counts())
  }

  private fun assertState(value: String) {
    compose
      .onNodeWithTag("image")
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, value))
  }

  private fun assertPixel(expected: Color) {
    val pixels = compose.onNodeWithTag("image").captureToImage().toPixelMap()
    assertEquals(expected, pixels[pixels.width / 2, pixels.height / 2])
  }
}
