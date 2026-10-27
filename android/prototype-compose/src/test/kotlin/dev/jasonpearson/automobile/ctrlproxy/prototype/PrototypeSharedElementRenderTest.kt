package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrototypeSharedElementRenderTest {
  @get:Rule val compose = createComposeRule()

  private fun show(profile: PrototypeMotionProfile, transition: String? = null): PrototypeRuntime {
    val visible = PrototypeCondition("expanded", PrototypeScalar.BooleanValue(true))
    val hidden = PrototypeCondition("expanded", PrototypeScalar.BooleanValue(false))
    val runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "shared",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          state = mapOf("expanded" to PrototypeScalar.BooleanValue(false)),
          root =
            PrototypeBoxNode(
              children =
                listOf(
                  PrototypeRowNode(
                    testTag = "row",
                    sharedKey = "item",
                    visibleWhen = hidden,
                    transition = transition?.let(::PrototypeTransition),
                    style =
                      PrototypeStyle(
                        width = PrototypeDimension.Dp(80.0),
                        height = PrototypeDimension.Dp(40.0),
                        background = PrototypeModeValue.Single("#FF0000"),
                      ),
                    children = emptyList(),
                  ),
                  PrototypeCardNode(
                    testTag = "card",
                    sharedKey = "item",
                    visibleWhen = visible,
                    transition = transition?.let(::PrototypeTransition),
                    style =
                      PrototypeStyle(
                        width = PrototypeDimension.Dp(200.0),
                        height = PrototypeDimension.Dp(160.0),
                        background = PrototypeModeValue.Single("#FF0000"),
                      ),
                    children = emptyList(),
                  ),
                ),
            ),
        ),
        nextSequence = { 1L },
      )
    compose.setContent {
      val snapshot by runtime.snapshots.collectAsState()
      CompositionLocalProvider(
        LocalPrototypeMotionProfile provides profile,
        LocalPrototypeMotion provides (profile != PrototypeMotionProfile.OFF),
        LocalPrototypeMotionActivity provides runtime.motionActivity,
      ) {
        Box(Modifier.size(300.dp).background(Color.White)) {
          PrototypeSpecContent(runtime.renderModel(snapshot).root)
        }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    return runtime
  }

  private fun expand(runtime: PrototypeRuntime, frames: Int = 3, elapsed: Long = 64) {
    compose.runOnUiThread {
      runBlocking {
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(
              PrototypeSetStateAction("expanded", PrototypeScalar.BooleanValue(true)),
            ),
          ),
        )
      }
    }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
    if (elapsed > 0) compose.mainClock.advanceTimeBy(elapsed)
  }

  @Test fun `full morph interpolates bounds and reports active until settled`() = morph(null)

  @Test fun `fade visibility branch participates in shared bounds`() = morph("fade")

  @Test fun `none visibility branch participates in shared bounds`() = morph("none")

  private fun morph(transition: String?) {
    val runtime = show(PrototypeMotionProfile.FULL, transition)
    val start = compose.onNodeWithTag("row").fetchSemanticsNode().boundsInRoot
    expand(runtime)
    val mid = compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot
    assertTrue(runtime.motionActivity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(2000)
    val end = compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot
    assertTrue("$start -> $mid -> $end", mid.width > start.width && mid.width < end.width)
    assertTrue(mid.height > start.height && mid.height < end.height)
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }

  @Test
  fun `reduced pair crossfades in place without interpolating bounds`() {
    val runtime = show(PrototypeMotionProfile.REDUCED, "slide")
    val rowStart = compose.onNodeWithTag("row").fetchSemanticsNode().boundsInRoot
    expand(runtime)
    // Both sides are on screen while they fade, each at its own target size: no morph, no shrink.
    assertEquals(rowStart, compose.onNodeWithTag("row").fetchSemanticsNode().boundsInRoot)
    val cardMid = compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot
    assertTrue(runtime.motionActivity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(2000)
    compose.onNodeWithTag("row").assertDoesNotExist()
    assertEquals(cardMid, compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot)
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }

  @Test
  fun `off swaps instantly without motion`() {
    val runtime = show(PrototypeMotionProfile.OFF)
    expand(runtime, frames = 1, elapsed = 0)
    compose.onNodeWithTag("row").assertDoesNotExist()
    val bounds = compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot
    assertEquals(0, runtime.motionActivity.snapshot().active)
    compose.mainClock.advanceTimeBy(2000)
    assertEquals(bounds, compose.onNodeWithTag("card").fetchSemanticsNode().boundsInRoot)
  }
}
