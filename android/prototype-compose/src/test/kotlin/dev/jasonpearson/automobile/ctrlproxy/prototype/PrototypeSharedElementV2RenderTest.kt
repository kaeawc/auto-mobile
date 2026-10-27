package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
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
class PrototypeSharedElementV2RenderTest {
  @get:Rule val compose = createComposeRule()

  private fun show(profile: PrototypeMotionProfile, kind: String): PrototypeRuntime {
    val input =
      """
      {"id":"feed","window":{"placement":{"type":"fullscreen"}},"state":{"open":false},
       "root":{"type":"box","children":[
        {"type":"column","repeat":{"items":[{"id":"one"},{"id":"two"}],"as":"item","key":"id"},
         "children":[{"type":"card","testTag":"card-{item.id}",
          "shared":{"key":"story-{item.id}","as":"$kind"},"visibleWhen":{"key":"open","equals":false},
          "style":{"width":{"dp":80},"height":{"dp":40},"background":"#FF0000"},"children":[]}]},
        {"type":"column","testTag":"detail","shared":{"key":"story-one","as":"$kind"},
         "visibleWhen":{"key":"open","equals":true},
         "style":{"width":{"dp":200},"height":{"dp":160},"background":"#FF0000"},"children":[]}]}}
      """
        .trimIndent()
    val result = PrototypeSpecValidator.validate(input)
    assertTrue(result.toString(), result is PrototypeSpecValidation.Success)
    val runtime =
      PrototypeRuntime((result as PrototypeSpecValidation.Success).spec, nextSequence = { 1L })
    compose.setContent {
      val snapshot by runtime.snapshots.collectAsState()
      CompositionLocalProvider(
        LocalPrototypeMotionProfile provides profile,
        LocalPrototypeMotion provides (profile != PrototypeMotionProfile.OFF),
        LocalPrototypeMotionActivity provides runtime.motionActivity,
      ) {
        Box(Modifier.size(300.dp)) { PrototypeSpecContent(runtime.renderModel(snapshot).root) }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    return runtime
  }

  private fun expand(runtime: PrototypeRuntime) {
    compose.runOnUiThread {
      runBlocking {
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(true))),
          ),
        )
      }
    }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    compose.mainClock.advanceTimeBy(64)
  }

  private fun morph(kind: String) {
    val runtime = show(PrototypeMotionProfile.FULL, kind)
    // Repeat identities are bound by the renderer; tags remain authored literals.
    val start = compose.onAllNodesWithTag("card-{item.id}")[0].fetchSemanticsNode().boundsInRoot
    expand(runtime)
    val mid = compose.onNodeWithTag("detail").fetchSemanticsNode().boundsInRoot
    assertTrue(runtime.motionActivity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(2000)
    val end = compose.onNodeWithTag("detail").fetchSemanticsNode().boundsInRoot
    assertTrue("$start -> $mid -> $end", mid.width > start.width && mid.width < end.width)
    assertTrue(mid.height > start.height && mid.height < end.height)
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }

  @Test fun `repeated card morphs into detail bounds`() = morph("bounds")

  @Test fun `repeated hero uses shared element geometry`() = morph("element")

  @Test
  fun `reduced crossfades without changing either side geometry`() {
    val runtime = show(PrototypeMotionProfile.REDUCED, "element")
    val start = compose.onAllNodesWithTag("card-{item.id}")[0].fetchSemanticsNode().boundsInRoot
    expand(runtime)
    assertEquals(
      start,
      compose.onAllNodesWithTag("card-{item.id}")[0].fetchSemanticsNode().boundsInRoot,
    )
    val mid = compose.onNodeWithTag("detail").fetchSemanticsNode().boundsInRoot
    assertTrue(runtime.motionActivity.snapshot().active > 0)
    compose.mainClock.advanceTimeBy(2000)
    compose.onAllNodesWithTag("card-{item.id}").assertCountEquals(0)
    assertEquals(mid, compose.onNodeWithTag("detail").fetchSemanticsNode().boundsInRoot)
  }

  @Test
  fun `off swaps the repeat for detail instantly`() {
    val runtime = show(PrototypeMotionProfile.OFF, "bounds")
    expand(runtime)
    compose.onAllNodesWithTag("card-{item.id}").assertCountEquals(0)
    compose.onNodeWithTag("detail").assertExists()
    assertEquals(0, runtime.motionActivity.snapshot().active)
  }
}
