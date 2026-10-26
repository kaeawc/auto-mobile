package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeListNode
import dev.jasonpearson.automobile.protocol.PrototypePopAction
import dev.jasonpearson.automobile.protocol.PrototypePrependDataAction
import dev.jasonpearson.automobile.protocol.PrototypePushAction
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeListAnchorRenderTest {
  @get:Rule val compose = createComposeRule()

  private fun show(stack: Boolean = false, header: Boolean = true): PrototypeRuntime {
    val original = PrototypeLazyListTest().spec(100)
    val list =
      (original.root as PrototypeListNode).copy(
        refresh = null,
        header = if (header) PrototypeTextNode(text = "Header") else null,
        style = PrototypeStyle(height = PrototypeDimension.Dp(160.0)),
      )
    val spec: PrototypeSpec =
      original.copy(
        motion = "none",
        root =
          if (stack)
            PrototypeStackNode(
              id = "nav",
              start = "home",
              screens = mapOf("home" to list, "detail" to PrototypeTextNode(text = "Detail")),
            )
          else list,
      )
    var sequence = 0L
    val runtime = PrototypeRuntime(spec, nextSequence = { ++sequence })
    compose.setContent {
      Box(Modifier.width(300.dp).height(400.dp)) {
        PrototypeRuntimeContent(runtime) { runtime.handle(it) }
      }
    }
    compose.waitForIdle()
    return runtime
  }

  private data class VisibleRow(val key: String, val top: Float)

  private fun firstRow(): VisibleRow {
    val node =
      compose
        .onAllNodesWithTag("row", useUnmergedTree = true)
        .fetchSemanticsNodes()
        .filter { it.boundsInRoot.height > 0f }
        .minBy { it.positionInRoot.y }
    val text = node.config[SemanticsProperties.Text].single().text
    return VisibleRow(text.substringAfter(": "), node.positionInRoot.y)
  }

  private fun act(runtime: PrototypeRuntime, action: PrototypeAction) {
    compose.runOnUiThread {
      runBlocking { runtime.handle(PrototypeInteraction.Tap(listOf(action))) }
    }
    compose.waitForIdle()
  }

  private fun prepend(runtime: PrototypeRuntime) {
    act(
      runtime,
      PrototypePrependDataAction(
        "/data/items",
        Json.parseToJsonElement("""{"value":[{"id":-1,"title":"New"}]}""").jsonObject,
      ),
    )
  }

  private fun feed(): SemanticsNodeInteraction = compose.onNodeWithTag("feed")

  @Test
  fun scrolledPrependRetainsFirstRowAndPixelOffset() {
    val runtime = show()
    feed().performScrollToIndex(21)
    feed().performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 17f) }
    compose.waitForIdle()
    val before = firstRow()
    prepend(runtime)
    val after = firstRow()
    assertEquals(before.key, after.key)
    assertEquals(before.top, after.top, 0.1f)
  }

  @Test
  fun topWithHeaderPrependKeepsPreviousFirstRowAtZeroScrollOffset() {
    val runtime = show()
    val before = firstRow()
    assertEquals("Post 0", before.key)
    prepend(runtime)
    val after = firstRow()
    assertEquals(before.key, after.key)
    assertEquals(feed().fetchSemanticsNode().positionInRoot.y, after.top, 0.1f)
  }

  @Test
  fun topWithoutHeaderPrependKeepsPreviousFirstRow() {
    val runtime = show(header = false)
    val before = firstRow()
    prepend(runtime)
    assertEquals(before, firstRow())
  }

  @Test
  fun listAnchorSurvivesStackPushAndPop() {
    val runtime = show(stack = true)
    feed().performScrollToIndex(21)
    feed().performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 17f) }
    compose.waitForIdle()
    val before = firstRow()
    assertTrue(before.key != "Post 0")
    act(runtime, PrototypePushAction("nav", "detail"))
    act(runtime, PrototypePopAction("nav"))
    assertEquals(before, firstRow())
  }
}
