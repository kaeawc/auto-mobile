package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
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
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrototypeStackPatternsRenderTest {
  @get:Rule val compose = createComposeRule()

  @Test fun sharedX() = exercise(PrototypeStackTransition.SHARED_AXIS_X)

  @Test fun sharedY() = exercise(PrototypeStackTransition.SHARED_AXIS_Y)

  @Test fun fadeThrough() = exercise(PrototypeStackTransition.FADE_THROUGH)

  @Test fun zoomFallback() = exercise(PrototypeStackTransition.ZOOM)

  private fun exercise(pattern: PrototypeStackTransition) {
    val seek = PrototypeBackSeek()
    val runtime = runtime(pattern)
    compose.setContent {
      androidx.compose.runtime.CompositionLocalProvider(LocalPrototypeBackSeek provides seek) {
        Box(Modifier.size(300.dp)) { PrototypeRuntimeContent(runtime) { runtime.handle(it) } }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"))
    val pushMid = frame()
    settle()
    val pushed = frame()
    assertFalse(pushMid.contentEquals(pushed))
    compose.onNodeWithTag("detail").assertExists()
    compose.runOnIdle {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.4f
    }
    androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    val preview = frame()
    assertFalse(preview.contentEquals(pushed))
    compose.runOnIdle { seek.result = false }
    androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
    settle()
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertTrue(frame().contentEquals(pushed))
    act(runtime, PrototypePopAction("nav"))
    val popMid = frame()
    settle()
    assertFalse(popMid.contentEquals(frame()))
    compose.onNodeWithTag("home").assertExists()
    compose.onNodeWithTag("detail").assertDoesNotExist()
  }

  private fun frame(): IntArray = compose.onRoot().captureToImage().toPixelMap().buffer

  private fun settle() {
    compose.mainClock.advanceTimeBy(400)
    compose.waitForIdle()
  }

  private fun act(runtime: PrototypeRuntime, action: PrototypeAction) {
    compose.runOnUiThread {
      runBlocking { runtime.handle(PrototypeInteraction.Tap(listOf(action))) }
    }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(100)
  }

  private fun runtime(pattern: PrototypeStackTransition) =
    PrototypeRuntime(
      PrototypeSpec(
        id = "patterns",
        window = PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeStackNode(
            id = "nav",
            start = "home",
            transition = PrototypeTransition(pattern.value),
            screens =
              mapOf(
                "home" to
                  PrototypeTextNode(
                    text = "Home",
                    testTag = "home",
                    sharedKey = "hero",
                    style = PrototypeStyle(background = PrototypeModeValue.Single("#ff0000")),
                  ),
                "detail" to
                  PrototypeTextNode(
                    text = "Detail",
                    testTag = "detail",
                    style = PrototypeStyle(background = PrototypeModeValue.Single("#0000ff")),
                  ),
              ),
          ),
      ),
      nextSequence = { 1 },
    )
}
