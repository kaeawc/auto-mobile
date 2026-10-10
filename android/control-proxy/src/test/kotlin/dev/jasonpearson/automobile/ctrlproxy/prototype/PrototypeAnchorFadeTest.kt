package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * An anchored node fades with the parent it was authored under, frame by frame, and stays composed
 * exactly until the parent's exit finishes (#10869). On a device it was clipped away on its first
 * translucent frame while its non-anchored sibling kept fading.
 */
@RunWith(RobolectricTestRunner::class)
class OverlayAnchorFadeTest {
  @get:Rule val compose = createComposeRule()

  private fun exitingParent(transition: String?): OverlayNode =
    OverlayBoxNode(
      testTag = "parent",
      transition = transition,
      visibleWhen = OverlayCondition("show", OverlayScalar.BooleanValue(true)),
      children =
        listOf(
          OverlayBoxNode(
            testTag = "child",
            style = OverlayStyle(background = "#FF0000"),
            anchor = OverlayBoundsAnchor(OverlayBounds(100.0, 200.0, 200.0, 200.0), "cover"),
            children = emptyList(),
          ),
          OverlayTextNode(text = "sibling", testTag = "sibling"),
        ),
    )

  private fun startExit(transition: String?) {
    val spec =
      OverlaySpec(
        "panel",
        OverlayWindow(OverlayFullscreenPlacement()),
        mapOf("show" to OverlayScalar.BooleanValue(true)),
        exitingParent(transition),
      )
    var sequence = 0L
    val runtime = OverlayRuntime(spec, nextSequence = { ++sequence })
    compose.setContent { OverlayRuntimeContent(runtime) { runtime.handle(it) } }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    runBlocking {
      runtime.handle(
        OverlayInteraction.Tap(
          listOf(OverlaySetStateAction("show", OverlayScalar.BooleanValue(false))),
        ),
      )
    }
  }

  private fun siblingPresent() =
    compose.onAllNodesWithTag("sibling", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

  /** The anchored child's fade, or null once it is no longer composed. */
  private fun childFade(): Float? =
    compose
      .onAllNodes(SemanticsMatcher.keyIsDefined(OverlayAnchorFadeKey), useUnmergedTree = true)
      .fetchSemanticsNodes()
      .singleOrNull()
      ?.config
      ?.get(OverlayAnchorFadeKey)

  private fun assertTracksParentThroughExit(transition: String?) {
    startExit(transition)
    val fades = mutableListOf<Float>()
    var frames = 0
    while (siblingPresent() && frames < 2_000) {
      val fade = childFade()
      assertTrue("child vanished at frame $frames while its parent is still exiting", fade != null)
      fades += fade!!
      compose.mainClock.advanceTimeByFrame()
      frames++
    }
    assertTrue("the parent's exit never finished", frames < 2_000)
    // Dropped from the layer at once, or at worst one frame later and then fully transparent.
    assertTrue(
      "child still drawn after its parent's exit: ${childFade()}",
      (childFade() ?: 0f) == 0f,
    )

    assertTrue("a fade that starts shown: ${fades.first()}", fades.first() > 0.9f)
    assertEquals("fades only ever fall", fades.sortedDescending(), fades)
    assertTrue(
      "mid-exit frames are translucent, not a snap",
      fades.count { it in 0.05f..0.95f } >= 3,
    )
    assertTrue("nearly transparent just before it goes: ${fades.last()}", fades.last() < 0.1f)
  }

  @Test
  fun `an anchored child fades frame by frame with a fading parent`() =
    assertTracksParentThroughExit("fade")

  @Test
  fun `an anchored child follows the default fade and shrink exit`() =
    assertTracksParentThroughExit(null)

  @Test
  fun `an anchored child follows a parent that only shrinks instead of outliving it`() =
    assertTracksParentThroughExit("expand")

  @Test
  fun `an anchored child under a none transition goes with its parent at once`() {
    startExit("none")
    var frames = 0
    while (siblingPresent() && frames++ < 5) compose.mainClock.advanceTimeByFrame()
    assertTrue("a none exit lasts frames", frames <= 3)
    assertTrue("drawn after its parent: ${childFade()}", (childFade() ?: 0f) == 0f)
  }
}
