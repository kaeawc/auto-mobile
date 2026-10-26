package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
    activity: PrototypeMotionActivity? = null,
    home: PrototypeNode = PrototypeTextNode(text = "Home", testTag = "home"),
    detail: PrototypeNode = PrototypeTextNode(text = "Detail", testTag = "detail"),
    probe: ((String) -> Unit)? = null,
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
                  "detail" to detail,
                ),
            ),
        ),
        sink = { events += it },
        nextSequence = { events.size.toLong() + 1 },
      )
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeBackSeek provides seek,
        LocalPrototypeCompositionProbe provides probe,
      ) {
        Box(Modifier.width(300.dp).height(400.dp)) {
          if (activity == null) {
            PrototypeRuntimeContent(runtime) { runtime.handle(it) }
          } else {
            val snapshot by runtime.snapshots.collectAsState()
            CompositionLocalProvider(
              LocalPrototypeMotionActivity provides activity,
              LocalPrototypeMotion provides prototypeMotionEnabled(motion, durationScale),
              LocalPrototypeStackRuntime provides runtime,
              LocalPrototypeStackSnapshot provides snapshot,
            ) {
              PrototypeSpecContent(runtime.renderModel(snapshot).root)
            }
          }
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
  fun `cancelled predictive back preserves top screen remembered edits and focus`() {
    val seek = PrototypeBackSeek()
    // This host deliberately leaves edits local, so a rebuilt field loses its remembered text.
    val runtime =
      show(
        seek = seek,
        activity = PrototypeMotionActivity(),
        detail = PrototypeTextFieldNode(stateKey = "draft", testTag = "detail"),
      )
    act(runtime, PrototypePushAction("nav", "detail"))
    settle()
    compose.onNodeWithTag("detail").performClick().performTextInput("unsent draft")
    compose.onNodeWithTag("detail").assertIsFocused()
    mutate {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.5f
    }
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    compose.onNodeWithTag("detail").assertTextEquals("unsent draft").assertIsFocused()
    mutate { seek.result = false }
    settle()
    compose.onNodeWithTag("detail").assertTextEquals("unsent draft").assertIsFocused()
  }

  @Test
  fun `committed predictive back retains the revealed screen composition and remembered edits`() {
    val seek = PrototypeBackSeek()
    val compositions = mutableMapOf<String, Int>()
    val runtime =
      show(
        seek = seek,
        activity = PrototypeMotionActivity(),
        home = PrototypeTextFieldNode(stateKey = "draft", testTag = "home"),
        probe = { compositions[it] = compositions.getOrDefault(it, 0) + 1 },
      )
    val homeIdentity = runtime.renderModel(runtime.current).root.children.single().identity
    act(runtime, PrototypePushAction("nav", "detail"))
    settle()
    compositions.clear()
    mutate {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.5f
    }
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(1, compositions[homeIdentity])
    compose.onNodeWithTag("home").performClick().performTextInput("preview draft")
    mutate {
      runBlocking { runtime.handle(PrototypeInteraction.Back) }
      seek.result = true
    }
    settle()
    compose.onNodeWithTag("home").assertTextEquals("preview draft").assertIsFocused()
    assertEquals(1, compositions[homeIdentity])
  }

  @Test
  fun `screen panes do not expose a container focus target`() {
    show()
    compose
      .onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "home"))
      .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Focused))
  }

  @Test
  fun `stack visibleWhen uses default visibility motion even with navigation none`() =
    assertStackVisibilityAnimation("none")

  @Test
  fun `stack visibleWhen animates without an authored transition`() =
    assertStackVisibilityAnimation(null)

  private fun assertStackVisibilityAnimation(transition: String?) {
    val spec =
      PrototypeSpec(
        "visibility",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("show" to PrototypeScalar.BooleanValue(true)),
        PrototypeStackNode(
          id = "nav",
          start = "home",
          transition = transition?.let(::PrototypeTransition),
          visibleWhen = PrototypeCondition("show", PrototypeScalar.BooleanValue(true)),
          screens = mapOf("home" to PrototypeTextNode(text = "Home", testTag = "home")),
        ),
      )
    var sequence = 0L
    val runtime = PrototypeRuntime(spec, nextSequence = { ++sequence })
    compose.setContent { PrototypeRuntimeContent(runtime) { runtime.handle(it) } }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    act(runtime, PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(false)))
    assertEquals(1, count("home"))
    compose.mainClock.advanceTimeBy(1000)
    assertEquals(0, count("home"))
    act(runtime, PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(true)))
    assertTrue(runtime.motionActivity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(1000)
    assertEquals(1, count("home"))
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }

  @Test
  fun `stack motion is active during push and pop and settled after each`() {
    val activity = PrototypeMotionActivity()
    val runtime = show(activity = activity)
    assertEquals(0, activity.snapshot().active)
    act(runtime, PrototypePushAction("nav", "detail"))
    assertTrue(activity.snapshot().active > 0)
    settle()
    assertEquals(0, activity.snapshot().active)
    act(runtime, PrototypePopAction("nav"))
    assertTrue(activity.snapshot().active > 0)
    settle()
    assertEquals(0, activity.snapshot().active)
  }

  @Test
  fun `predictive back reports motion while held and while cancelling or committing`() {
    val activity = PrototypeMotionActivity()
    val seek = PrototypeBackSeek()
    val runtime = show(seek = seek, activity = activity)
    act(runtime, PrototypePushAction("nav", "detail"))
    settle()
    for (commit in listOf(false, true)) {
      mutate {
        seek.start(checkNotNull(runtime.backPreview()))
        seek.progress = 0.5f
      }
      repeat(4) { compose.mainClock.advanceTimeByFrame() }
      assertTrue(activity.snapshot().active > 0)
      // A stationary gesture still owns an unsettled transition.
      settle()
      assertTrue(activity.snapshot().active > 0)
      mutate {
        if (commit) runBlocking { runtime.handle(PrototypeInteraction.Back) }
        seek.result = commit
      }
      repeat(3) { compose.mainClock.advanceTimeByFrame() }
      assertTrue(activity.snapshot().active > 0)
      settle()
      assertEquals(0, activity.snapshot().active)
    }
  }

  @Test
  fun `stack motion stays zero with motion off including predictive back`() {
    val activity = PrototypeMotionActivity()
    val seek = PrototypeBackSeek()
    val runtime = show(motion = "none", seek = seek, activity = activity)
    act(runtime, PrototypePushAction("nav", "detail"), frames = 1)
    assertEquals(0, activity.snapshot().active)
    mutate {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.5f
    }
    compose.mainClock.advanceTimeByFrame()
    assertEquals(0, activity.snapshot().active)
    mutate { seek.result = false }
    compose.mainClock.advanceTimeByFrame()
    assertEquals(0, activity.snapshot().active)
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
    act(runtime, PrototypePushAction("nav", "detail", PrototypeStackTransition.NONE.value), frames = 1)
    assertEquals(0, count("home"))
    assertEquals(0, runtime.motionActivity.snapshot().active)
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
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }

  @Test
  fun `zero animator scale removes outgoing in one frame`() {
    val runtime = show(durationScale = 0f)
    act(runtime, PrototypePushAction("nav", "detail"), frames = 1)
    assertEquals(0, count("home"))
    assertEquals(1, count("detail"))
    assertEquals(0, runtime.motionActivity.snapshot().active)
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
