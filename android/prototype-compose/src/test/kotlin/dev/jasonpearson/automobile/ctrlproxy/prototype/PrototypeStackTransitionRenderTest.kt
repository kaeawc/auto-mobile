package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PrototypeStackTransitionRenderTest {
  @get:Rule val compose = createComposeRule()
  private val events = mutableListOf<PrototypeEvent>()

  private fun show(
    motion: String? = null,
    durationScale: Float = 1f,
    seek: PrototypeBackSeek? = null,
    home: PrototypeNode = PrototypeTextNode(text = "Home", testTag = "home"),
  ): PrototypeRuntime {
    Settings.Global.putFloat(
      RuntimeEnvironment.getApplication().contentResolver,
      Settings.Global.ANIMATOR_DURATION_SCALE,
      durationScale,
    )
    val runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "stack-test",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          motion = motion,
          root =
            PrototypeStackNode(
              id = "nav",
              start = "home",
              screens =
                mapOf(
                  "home" to home,
                  "detail" to PrototypeTextNode(text = "Detail", testTag = "detail"),
                ),
            ),
        ),
        sink = { events += it },
        nextSequence = { events.size.toLong() + 1 },
      )
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeBackSeek provides seek) {
        Box(Modifier.width(300.dp).height(400.dp)) {
          PrototypeRuntimeContent(runtime) { runtime.handle(it) }
        }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    return runtime
  }

  @After
  fun restoreScale() {
    Settings.Global.putFloat(
      RuntimeEnvironment.getApplication().contentResolver,
      Settings.Global.ANIMATOR_DURATION_SCALE,
      1f,
    )
  }

  private fun act(runtime: PrototypeRuntime, action: PrototypeAction, frames: Int = 3) {
    compose.runOnUiThread {
      runBlocking { runtime.handle(PrototypeInteraction.Tap(listOf(action))) }
    }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
  }

  private fun mutate(block: () -> Unit) {
    compose.runOnIdle(block)
    androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
  }

  private fun count(tag: String) =
    compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size

  private fun settle() {
    compose.mainClock.advanceTimeBy(400)
    compose.waitForIdle()
  }

  @Test
  fun `push and pop retain outgoing only during transition and title the settled pane`() {
    val runtime = show()
    act(runtime, PrototypePushAction("nav", "detail"))
    assertEquals(1, count("home"))
    assertEquals(1, count("detail"))
    settle()
    assertEquals(0, count("home"))
    compose
      .onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "detail"))
      .assertExists()
    act(runtime, PrototypePopAction("nav"))
    assertEquals(1, count("home"))
    assertEquals(1, count("detail"))
    settle()
    assertEquals(0, count("detail"))
  }

  @Test
  fun `an instant push override does not disable the following pop animation`() {
    val runtime = show()
    act(runtime, PrototypePushAction("nav", "detail", PrototypeStackTransition.NONE), frames = 1)
    assertEquals(0, count("home"))
    act(runtime, PrototypePopAction("nav"))
    assertEquals(1, count("home"))
    assertEquals(1, count("detail"))
    settle()
    assertEquals(0, count("detail"))
  }

  @Test
  fun `motion none removes outgoing without animation time`() {
    val runtime = show("none")
    act(runtime, PrototypePushAction("nav", "detail"), frames = 1)
    assertEquals(0, count("home"))
    assertEquals(1, count("detail"))
  }

  @Test
  fun `zero animator scale removes outgoing in one frame`() {
    val runtime = show(durationScale = 0f)
    act(runtime, PrototypePushAction("nav", "detail"), frames = 1)
    assertEquals(0, count("home"))
    assertEquals(1, count("detail"))
  }

  @Test
  fun `scroll offset survives a covered entry`() {
    val runtime =
      show(
        home =
          PrototypeScrollNode(
            testTag = "scroll",
            style = PrototypeStyle(height = PrototypeDimension.Dp(200.0)),
            child =
              PrototypeColumnNode(
                children =
                  listOf(
                    PrototypeTextNode(text = "Top"),
                    PrototypeSpacerNode(
                      style = PrototypeStyle(height = PrototypeDimension.Dp(1000.0)),
                    ),
                    PrototypeTextNode(text = "Bottom", testTag = "bottom"),
                  ),
              ),
          ),
      )
    compose.mainClock.autoAdvance = true
    compose.onNodeWithTag("bottom").performScrollTo()
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.mainClock.advanceTimeByFrame()
    fun offset() =
      compose
        .onNodeWithTag("scroll")
        .fetchSemanticsNode()
        .config[SemanticsProperties.VerticalScrollAxisRange]
        .value()
    val before = offset()
    assertTrue(before > 0f)
    act(runtime, PrototypePushAction("nav", "detail"))
    settle()
    act(runtime, PrototypePopAction("nav"))
    settle()
    assertEquals(before, offset(), 0.1f)
  }

  @Test
  fun `cancelled seek keeps depth and committed seek emits a real pop`() {
    val seek = PrototypeBackSeek()
    val runtime = show(seek = seek)
    act(runtime, PrototypePushAction("nav", "detail"))
    settle()
    mutate {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.5f
    }
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(1, count("home"))
    mutate { seek.result = false }
    settle()
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertEquals(0, count("home"))
    mutate {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.6f
    }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    mutate {
      runBlocking { runtime.handle(PrototypeInteraction.Back) }
      seek.result = true
    }
    settle()
    assertEquals(1, runtime.current.stacks.getValue("nav").depth)
    assertEquals(0, count("detail"))
    assertEquals(2, events.count { it.kind == PrototypeEventKind.SCREEN_CHANGED })
  }
}
