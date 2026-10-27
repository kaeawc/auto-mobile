package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Icon
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeEffectIconTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `crossfade glyph fills the styled icon bounds`() {
    val source = PrototypeIconNode(name = "home", effect = PrototypeIconEffect("replace"))
    val node =
      PrototypeRenderNode(
        "icon",
        "",
        null,
        true,
        mapPrototypeStyle(PrototypeStyle()),
        null,
        source = source,
      )
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides true) {
        PrototypeEffectIcon(
          Icons.Default.Home,
          node,
          Modifier.size(48.dp),
          Color.Black,
        ) { image, glyphModifier ->
          Icon(image, null, glyphModifier.testTag("glyph"))
        }
      }
    }
    compose.onNodeWithTag("glyph").assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
  }

  @Test
  fun `reduced replace leaves layer at rest during name crossfade`() {
    compose.mainClock.autoAdvance = false
    var name by mutableStateOf("home")
    var frame = PrototypeIconFrame()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
      ) {
        val current = rememberPrototypeIconFrame(PrototypeIconEffect("replace"), null, name)
        SideEffect { frame = current }
      }
    }
    compose.runOnIdle { name = "star" }
    compose.mainClock.advanceTimeBy(144)
    compose.runOnIdle { assertEquals(PrototypeIconFrame(), frame) }
  }
}
