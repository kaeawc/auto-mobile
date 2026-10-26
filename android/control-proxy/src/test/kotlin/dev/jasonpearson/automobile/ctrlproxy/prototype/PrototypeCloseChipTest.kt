package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The circular close chip every Android host dismiss control (other than the chromeless escape
 * pill) shares with iOS's `automobile-prototype-dismiss` chip (#15119).
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeCloseChipTest {
  @get:Rule val compose = createComposeRule()
  private var dismissals = 0

  private fun show(
    placement: PrototypePlacement,
    chrome: PrototypeWindowChrome = PrototypeWindowChrome.NONE,
    persistent: Boolean = false,
    opacity: Int = 100,
  ) {
    val request =
      PrototypeRequest(
        placement,
        persistent = persistent,
        chrome = chrome,
        opacityPercent = opacity,
        onHostDismiss = { dismissals++ },
        content = { Box(Modifier.fillMaxSize().testTag("authored")) { Text("Authored") } },
      )
    compose.setContent { PrototypeWindowContent(request) { PrototypeInsetFloor.None } }
    compose.waitForIdle()
  }

  private fun chip() = compose.onNodeWithTag(PROTOTYPE_DISMISS_TEST_TAG)

  @Test
  fun `the shared id and label are the iOS ones`() {
    assertEquals("automobile-prototype-dismiss", PROTOTYPE_DISMISS_TEST_TAG)
    assertEquals("Dismiss AutoMobile prototype", PROTOTYPE_DISMISS_LABEL)
  }

  @Test
  fun `the dismiss bar draws the chip with its id and description and no text label`() {
    show(PrototypePlacement.Fullscreen(), PrototypeWindowChrome.BAR)
    chip().assertIsDisplayed()
    compose.onNodeWithContentDescription(PROTOTYPE_DISMISS_LABEL).assertIsDisplayed()
    compose.onNodeWithText(PROTOTYPE_DISMISS_LABEL).assertDoesNotExist()
    compose.onNodeWithText("Close").assertDoesNotExist()
  }

  @Test
  fun `the chip has a 48 dp hit target and dismisses once`() {
    show(PrototypePlacement.Fullscreen(), PrototypeWindowChrome.BAR)
    val bounds = chip().fetchSemanticsNode().touchBoundsInRoot
    val density = compose.density.density
    assertTrue("width ${bounds.width}", bounds.width >= 48.dp.value * density - 0.5f)
    assertTrue("height ${bounds.height}", bounds.height >= 48.dp.value * density - 0.5f)
    assertTrue(chip().fetchSemanticsNode().config.contains(SemanticsProperties.ContentDescription))
    chip().performClick()
    compose.runOnIdle { assertEquals(1, dismissals) }
  }

  @Test
  fun `a persistent floating window draws the chip`() {
    show(PrototypePlacement.Floating(), persistent = true)
    chip().assertIsDisplayed()
    compose.onNodeWithText("Close").assertDoesNotExist()
  }

  @Test
  fun `a persistent sheet draws the chip`() {
    show(PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 100f), persistent = true)
    chip().assertIsDisplayed()
    compose.onNodeWithText("Close").assertDoesNotExist()
  }

  @Test
  fun `a session floating window draws no chip`() {
    show(PrototypePlacement.Floating(), persistent = false)
    chip().assertDoesNotExist()
  }

  @Test
  fun `a chromeless window draws no chip`() {
    show(PrototypePlacement.Fullscreen(), PrototypeWindowChrome.NONE)
    chip().assertDoesNotExist()
  }

  @Test
  fun `the persistent chip is still the visible control at opacity zero`() {
    show(PrototypePlacement.Floating(), persistent = true, opacity = 0)
    chip().assertIsDisplayed().performClick()
    compose.runOnIdle { assertEquals(1, dismissals) }
  }
}
