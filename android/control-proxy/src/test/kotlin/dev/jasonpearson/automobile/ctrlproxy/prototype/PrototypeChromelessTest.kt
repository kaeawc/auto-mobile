package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class PrototypeChromelessTest {
  @get:Rule val compose = createComposeRule()
  private val escape = PrototypeEscapeState()
  private var dismissals = 0
  private var manager =
    RuntimeEnvironment.getApplication().getSystemService(Context.ACCESSIBILITY_SERVICE)
      as AccessibilityManager

  @After
  fun resetAccessibility() {
    shadowOf(manager).setTouchExplorationEnabled(false)
  }

  private fun spec(chrome: String? = null, persistence: String? = null) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement(), chrome = chrome, persistence = persistence),
      root = PrototypeTextNode(text = "Authored"),
    )

  private fun show(chrome: PrototypeWindowChrome = PrototypeWindowChrome.NONE, opacity: Int = 100) {
    val request =
      PrototypeRequest(
        PrototypePlacement.Fullscreen(),
        chrome = chrome,
        opacityPercent = opacity,
        onHostDismiss = { dismissals++ },
        content = { Box(Modifier.fillMaxSize().testTag("authored")) { Text("Authored") } },
      )
    compose.setContent {
      manager =
        LocalContext.current.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
      PrototypeWindowContent(request, escape) { PrototypeInsetFloor.None }
    }
    compose.waitForIdle()
  }

  private fun pill() = compose.onNodeWithText("Dismiss AutoMobile prototype")

  private fun reveal() {
    compose.runOnIdle { escape.reveal() }
    compose.waitForIdle()
  }

  @Test
  fun `spec defaults and explicit chrome are resolved and unknown values throw`() {
    assertEquals(PrototypeWindowChrome.NONE, prototypeWindowChrome(spec()))
    assertEquals(PrototypeWindowChrome.BAR, prototypeWindowChrome(spec(persistence = "device")))
    assertEquals(PrototypeWindowChrome.NONE, prototypeWindowChrome(spec("none", "device")))
    assertEquals(PrototypeWindowChrome.BAR, prototypeWindowChrome(spec("bar")))
    val error =
      assertThrows(IllegalStateException::class.java) { prototypeWindowChrome(spec("unknown")) }
    assertEquals("window.chrome: Unknown chrome", error.message)
    assertEquals(PrototypeWindowChrome.BAR, mapPrototypeSpec(spec()).request().chrome)
  }

  @Test
  fun `host chrome table preserves all placements and alpha contracts`() {
    for (persistent in listOf(false, true)) {
      for (chrome in PrototypeWindowChrome.entries) {
        val fullscreen =
          prototypeHostChrome(
            PrototypeRequest(
              PrototypePlacement.Fullscreen(),
              persistent = persistent,
              chrome = chrome,
              opacityPercent = 40,
            ),
          )
        assertEquals(chrome == PrototypeWindowChrome.BAR, fullscreen.dismissVisible)
        assertEquals(chrome == PrototypeWindowChrome.NONE, fullscreen.escape)
        assertFalse(fullscreen.closeVisible)
        assertEquals(1f, fullscreen.windowAlpha, 0f)
        assertEquals(0.4f, fullscreen.contentAlpha, 0f)
        for (placement in
          listOf(
            PrototypePlacement.Floating(),
            PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 100f),
          )) {
          val other =
            prototypeHostChrome(
              PrototypeRequest(
                placement,
                persistent = persistent,
                chrome = chrome,
                opacityPercent = 40,
              ),
            )
          assertFalse(other.dismissVisible)
          assertFalse(other.escape)
          assertEquals(persistent, other.closeVisible)
          assertEquals(if (persistent) 1f else 0.4f, other.windowAlpha, 0f)
          assertEquals(if (persistent) 0.4f else 1f, other.contentAlpha, 0f)
        }
      }
    }
  }

  @Test
  fun `chromeless content starts at window top without a dismiss row`() {
    show()
    pill().assertDoesNotExist()
    assertEquals(0f, compose.onNodeWithTag("authored").fetchSemanticsNode().boundsInRoot.top, 0f)
  }

  @Test
  fun `bar keeps content below its reserved dismiss row`() {
    show(PrototypeWindowChrome.BAR)
    compose.onNodeWithTag(PROTOTYPE_DISMISS_TEST_TAG).assertIsDisplayed()
    assertTrue(compose.onNodeWithTag("authored").fetchSemanticsNode().boundsInRoot.top > 0f)
  }

  @Test
  fun `revealed pill dismisses once and hides after five seconds`() {
    show()
    reveal()
    pill().assertIsDisplayed().performClick()
    compose.runOnIdle { assertEquals(1, dismissals) }
    compose.mainClock.advanceTimeBy(PROTOTYPE_ESCAPE_PILL_MILLIS)
    pill().assertDoesNotExist()
  }

  @Test
  fun `second reveal restarts the five second timeout`() {
    show()
    reveal()
    compose.mainClock.advanceTimeBy(3_000)
    reveal()
    compose.mainClock.advanceTimeBy(3_000)
    pill().assertIsDisplayed()
    compose.mainClock.advanceTimeBy(2_000)
    pill().assertDoesNotExist()
  }

  @Test
  fun `host wrapper exposes dismiss accessibility action even without a pill`() {
    show(opacity = 0)
    pill().assertDoesNotExist()
    compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(
      SemanticsActions.Dismiss,
    ) {
      assertTrue(it())
    }
    compose.runOnIdle { assertEquals(1, dismissals) }
  }

  @Test
  fun `dismiss wrapper leaves authored text separate and is neither clickable nor focusable`() {
    show()
    val authored = compose.onNodeWithText("Authored").assertIsDisplayed().fetchSemanticsNode()
    val wrapper =
      compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).fetchSemanticsNode()
    assertNotEquals(wrapper.id, authored.id)
    assertFalse(wrapper.config.isMergingSemanticsOfDescendants)
    assertFalse(wrapper.config.contains(SemanticsActions.OnClick))
    assertFalse(wrapper.config.contains(SemanticsActions.RequestFocus))
    assertFalse(wrapper.config.contains(SemanticsProperties.Focused))
    assertFalse(wrapper.config.contains(SemanticsProperties.Text))
  }

  @Test
  fun `touch exploration keeps the pill visible without reveal or timeout and follows changes`() {
    shadowOf(manager).setTouchExplorationEnabled(true)
    show()
    pill().assertIsDisplayed()
    compose.mainClock.advanceTimeBy(10_000)
    pill().assertIsDisplayed()
    compose.runOnIdle { shadowOf(manager).setTouchExplorationEnabled(false) }
    compose.waitForIdle()
    pill().assertDoesNotExist()
    compose.runOnIdle { shadowOf(manager).setTouchExplorationEnabled(true) }
    compose.waitForIdle()
    pill().assertIsDisplayed()
  }

  @Test
  fun `opacity zero fades content only and the pill still dismisses`() {
    val chrome =
      prototypeHostChrome(
        PrototypeRequest(
          PrototypePlacement.Fullscreen(),
          chrome = PrototypeWindowChrome.NONE,
          opacityPercent = 0,
        ),
      )
    assertEquals(0f, chrome.contentAlpha, 0f)
    assertEquals(1f, chrome.windowAlpha, 0f)
    show(opacity = 0)
    reveal()
    pill().assertIsDisplayed().performClick()
    compose.runOnIdle { assertEquals(1, dismissals) }
  }
}
