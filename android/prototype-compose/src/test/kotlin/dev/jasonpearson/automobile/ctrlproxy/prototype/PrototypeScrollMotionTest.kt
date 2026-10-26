package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class PrototypeScrollMotionTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `scrolling feed to 80dp draws linked alpha at one half with motion off`() {
    val source =
      PrototypeScrollNode(
        id = "feed",
        testTag = "feed",
        style = PrototypeStyle(height = PrototypeDimension.Dp(100.0)),
        child = PrototypeSpacerNode(style = PrototypeStyle(height = PrototypeDimension.Dp(1000.0))),
      )
    val linked =
      PrototypeBoxNode(
        testTag = "linked",
        style =
          PrototypeStyle(
            width = PrototypeDimension.Dp(40.0),
            height = PrototypeDimension.Dp(40.0),
            background = PrototypeModeValue.Single("#000000"),
          ),
        scrollLinked = PrototypeScrollLinked("feed", listOf(0.0, 160.0), alpha = listOf(1.0, 0.0)),
        children = emptyList(),
      )
    val spec =
      PrototypeSpec(
        "motion",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        emptyMap(),
        PrototypeColumnNode(children = listOf(source, linked)),
        motion = "none",
      )
    var density = 1f
    compose.setContent {
      val currentDensity = LocalDensity.current.density
      SideEffect { density = currentDensity }
      Box(Modifier.fillMaxSize().background(Color.White)) {
        PrototypeSpecContent(PrototypeRenderMapper().map(spec, emptyMap()).root)
      }
    }
    compose.onNodeWithTag("feed").performSemanticsAction(SemanticsActions.ScrollBy) {
      it(0f, 80f * density)
    }
    compose.waitForIdle()
    val pixels = compose.onNodeWithTag("linked").captureToImage().toPixelMap()
    assertEquals(0.5f, pixels[pixels.width / 2, pixels.height / 2].red, 0.02f)
  }
}
