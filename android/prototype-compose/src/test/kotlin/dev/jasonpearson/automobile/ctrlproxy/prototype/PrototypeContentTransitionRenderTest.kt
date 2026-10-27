package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.AnnotatedString
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeContentTransitionRenderTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `changed digit rolls while unchanged digits stay and semantics immediately use new text`() {
    var value by mutableStateOf("139")
    val activity = PrototypeMotionActivity()
    val layers = mutableListOf<String>()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides true,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        PrototypeContentTransition(
          AnnotatedString(value),
          "numeric",
          false,
          Modifier.testTag("text"),
        ) { shown, modifier ->
          DisposableEffect(shown.text) {
            layers.add(shown.text)
            onDispose { layers.remove(shown.text) }
          }
          Text(shown, modifier)
        }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread { value = "149" }
    compose.mainClock.advanceTimeByFrame()
    compose.onNodeWithTag("text").assertTextEquals("149")
    compose.mainClock.advanceTimeBy(64)
    compose.runOnIdle {
      assertTrue(activity.snapshot().active > 0)
      assertEquals(1, layers.count { it == "1" })
      assertEquals(1, layers.count { it == "9" })
      assertTrue(layers.containsAll(listOf("3", "4")))
    }
    compose.mainClock.advanceTimeBy(2000)
    compose.runOnIdle { assertEquals(0, activity.snapshot().active) }
    compose.onNodeWithTag("text").assertTextEquals("149")
    compose.runOnIdle { assertFalse(layers.contains("3")) }
  }

  @Test
  fun `motion disabled is instant with no outgoing label`() {
    var value by mutableStateOf("9")
    val activity = PrototypeMotionActivity()
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeMotion provides false,
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.FULL,
        LocalPrototypeMotionActivity provides activity,
      ) {
        PrototypeContentTransition(
          AnnotatedString(value),
          "numeric",
          false,
          Modifier.testTag("text"),
        ) { shown, modifier ->
          Text(shown, modifier)
        }
      }
    }
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread { value = "10" }
    compose.mainClock.advanceTimeByFrame()
    compose.onNodeWithTag("text").assertTextEquals("10")
    compose.onNodeWithText("9").assertDoesNotExist()
    compose.runOnIdle { assertEquals(0, activity.snapshot().active) }
  }
}
