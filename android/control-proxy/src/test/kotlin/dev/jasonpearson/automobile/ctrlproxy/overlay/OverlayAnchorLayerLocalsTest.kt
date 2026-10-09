package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.ContentResolver
import android.os.Looper
import android.provider.Settings
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.text.TextLayoutResult
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * An anchored node is drawn in a window-level layer (#10803), yet keeps what its authored position
 * provides: the card's content colour, and the visibility of the ancestors it was authored under.
 */
@RunWith(RobolectricTestRunner::class)
class OverlayAnchorLayerLocalsTest {
  @get:Rule val compose = createComposeRule()

  private var resolver: ContentResolver = RuntimeEnvironment.getApplication().contentResolver
  private var sequence = 0L

  private fun setDurationScale(scale: Float) {
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
    resolver.notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), null)
    shadowOf(Looper.getMainLooper()).idle()
  }

  private fun show(root: OverlayNode, state: Map<String, OverlayScalar> = emptyMap()): OverlayRuntime {
    val spec = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)
    val runtime = OverlayRuntime(spec, nextSequence = { ++sequence })
    compose.setContent {
      resolver = LocalContext.current.contentResolver
      OverlayRuntimeContent(runtime) { runtime.handle(it) }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    return runtime
  }

  private fun count(tag: String): Int =
    compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

  private fun textColor(tag: String): Color {
    val node = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().single()
    val results = mutableListOf<TextLayoutResult>()
    node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(results)
    return results.single().layoutInput.style.color
  }

  private val bounds = OverlayBounds(10.0, 20.0, 60.0, 40.0)

  private fun anchoredText(tag: String) =
    OverlayTextNode(text = tag, testTag = tag, anchor = OverlayBoundsAnchor(bounds))

  @Test
  fun `anchored text inside a card uses the card's content colour`() {
    setDurationScale(1f)
    show(
      OverlayColumnNode(
        children =
          listOf(
            OverlayTextNode(text = "outside", testTag = "outside"),
            OverlayCardNode(
              style = OverlayStyle(background = "#6750A4"),
              children =
                listOf(OverlayTextNode(text = "plain", testTag = "plain"), anchoredText("anchored")),
            ),
          ),
      ),
    )
    // A primary container gives onPrimary text, which the window itself does not.
    assertNotEquals(textColor("outside"), textColor("plain"))
    assertEquals(textColor("plain"), textColor("anchored"))
  }

  private fun hideableParent() =
    OverlayBoxNode(
      testTag = "parent",
      visibleWhen = OverlayCondition("show", OverlayScalar.BooleanValue(true)),
      children = listOf(anchoredText("child")),
    )

  private val hide = OverlaySetStateAction("show", OverlayScalar.BooleanValue(false))

  private fun OverlayRuntime.hideAfter(frames: Int) {
    runBlocking { handle(OverlayInteraction.Tap(listOf(hide))) }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
  }

  private val shown = mapOf("show" to OverlayScalar.BooleanValue(true))

  @Test
  fun `an anchored child fades out with its parent under animation`() {
    setDurationScale(1f)
    val runtime = show(hideableParent(), shown)
    assertEquals(1, count("child"))

    runtime.hideAfter(frames = 2)
    assertEquals("still fading with the parent", 1, count("child"))

    compose.mainClock.advanceTimeBy(2_000)
    assertEquals(0, count("child"))
  }

  @Test
  fun `an anchored child disappears with its parent at once with animator scale zero`() {
    setDurationScale(0f)
    val runtime = show(hideableParent(), shown)
    assertEquals(1, count("child"))

    runtime.hideAfter(frames = 1)

    assertEquals(0, count("child"))
  }
}
