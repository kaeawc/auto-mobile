package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
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
class PrototypeStackZoomRenderTest {
  @get:Rule val compose = createComposeRule()
  private val seek = PrototypeBackSeek()

  @Test
  fun `push morphs source bounds into destination root and settles`() {
    val runtime = show()
    val start = stackZoomInkBounds(compose.onRoot())
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"))
    val mid = stackZoomInkBounds(compose.onRoot())
    settle()
    val end = stackZoomInkBounds(compose.onRoot())
    assertTrue("$start -> $mid -> $end", mid.width > start.width && mid.width < end.width)
    assertTrue(mid.height > start.height && mid.height < end.height)
    compose.onNodeWithTag("hero").assertDoesNotExist()
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }

  @Test
  fun `pop reverses source to root transform`() {
    val runtime = show()
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"))
    settle()
    val start = bounds("detail")
    act(runtime, PrototypePopAction("nav"))
    val mid = bounds("hero")
    settle()
    val end = bounds("hero")
    assertTrue("$start -> $mid -> $end", mid.width < start.width && mid.width > end.width)
    compose.onNodeWithTag("detail").assertDoesNotExist()
  }

  @Test
  fun `cancelled predictive back scrubs bounds then restores destination`() {
    val runtime = show()
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"))
    settle()
    val start = stackZoomInkBounds(compose.onRoot())
    compose.runOnIdle {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.5f
    }
    Snapshot.sendApplyNotifications()
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    val mid = stackZoomInkBounds(compose.onRoot())
    assertTrue("$start -> $mid", mid.width < start.width)
    compose.runOnIdle { seek.result = false }
    Snapshot.sendApplyNotifications()
    settle()
    assertEquals(start, stackZoomInkBounds(compose.onRoot()))
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    compose.onNodeWithTag("hero").assertDoesNotExist()
  }

  @Test
  fun `committed predictive back restores the source frame`() {
    val runtime = show()
    val home = stackZoomInkBounds(compose.onRoot())
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"))
    settle()
    compose.runOnIdle {
      seek.start(checkNotNull(runtime.backPreview()))
      seek.progress = 0.5f
    }
    Snapshot.sendApplyNotifications()
    repeat(4) { compose.mainClock.advanceTimeByFrame() }
    compose.runOnUiThread {
      runBlocking { runtime.popTopmostStack() }
      seek.result = true
    }
    Snapshot.sendApplyNotifications()
    settle()
    assertEquals(home, stackZoomInkBounds(compose.onRoot()))
    assertEquals(1, runtime.current.stacks.getValue("nav").depth)
    compose.onNodeWithTag("detail").assertDoesNotExist()
  }

  @Test
  fun `reduced crossfades without changing either bounds`() {
    val runtime = show("reduced")
    val start = bounds("hero")
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"))
    assertEquals(start, bounds("hero"))
    val mid = bounds("detail")
    assertTrue(runtime.motionActivity.snapshot().active > 0)
    settle()
    assertEquals(mid, bounds("detail"))
    compose.onNodeWithTag("hero").assertDoesNotExist()
  }

  @Test
  fun `off is instant`() {
    val runtime = show("none")
    act(runtime, PrototypePushAction("nav", "detail", source = "hero"), elapsed = 0, frames = 1)
    compose.onNodeWithTag("hero").assertDoesNotExist()
    val end = bounds("detail")
    assertEquals(0, runtime.motionActivity.snapshot().active)
    settle()
    assertEquals(end, bounds("detail"))
  }

  @Test
  fun `replace morphs to new root and does not add depth`() {
    val runtime = show()
    val start = bounds("hero")
    act(runtime, PrototypeReplaceAction("nav", "detail", source = "hero"))
    assertTrue(bounds("detail").width > start.width)
    settle()
    assertEquals(1, runtime.current.stacks.getValue("nav").depth)
    compose.onNodeWithTag("hero").assertDoesNotExist()
  }

  private fun show(motion: String = "standard"): PrototypeRuntime {
    val runtime = stackZoomRuntime(motion)
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeBackSeek provides seek) {
        Box(Modifier.size(300.dp)) { PrototypeRuntimeContent(runtime) { runtime.handle(it) } }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    return runtime
  }

  private fun bounds(tag: String): Rect =
    compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot

  private fun settle() {
    compose.mainClock.advanceTimeBy(1000)
    compose.waitForIdle()
  }

  private fun act(
    runtime: PrototypeRuntime,
    action: PrototypeAction,
    elapsed: Long = 100,
    frames: Int = 3,
  ) {
    compose.runOnUiThread {
      runBlocking { runtime.handle(PrototypeInteraction.Tap(listOf(action))) }
    }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(elapsed)
  }
}
