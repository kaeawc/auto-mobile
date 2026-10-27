package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeLazyListSemanticsTest {
  @get:Rule val compose = createComposeRule()

  private fun show(axis: String) {
    val original = PrototypeLazyListTest().spec(100, axis)
    val spec =
      original.copy(
        root =
          (original.root as PrototypeListNode).copy(
            refresh = null,
            style =
              PrototypeStyle(
                width = PrototypeDimension.Dp(200.0),
                height = PrototypeDimension.Dp(160.0),
              ),
          ),
      )
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeFillsWindow provides true,
        LocalPrototypeMotion provides false,
      ) {
        Box(Modifier.fillMaxSize()) { PrototypeSpecContent(mapPrototypeSpec(spec).root) }
      }
    }
  }

  private fun verify(axis: String) {
    show(axis)
    val feed = compose.onNodeWithTag("feed").assertContentDescriptionEquals("Posts")
    feed.assert(hasScrollAction())
    val info = feed.fetchSemanticsNode().config[SemanticsProperties.CollectionInfo]
    if (axis == "vertical") assertEquals(1, info.columnCount) else assertEquals(1, info.rowCount)
    compose.onNodeWithText("0: Post 0").assertExists()
    compose.onNodeWithText("99: Post 99").assertDoesNotExist()
    val texts =
      compose.onAllNodesWithTag("row", useUnmergedTree = true).fetchSemanticsNodes().map {
        it.config[SemanticsProperties.Text].single().text
      }
    assertTrue(texts.size < 100)
    assertEquals(texts.sortedBy { it.substringBefore(':').toInt() }, texts)
    feed.performScrollToIndex(100)
    compose.onNodeWithText("99: Post 99").assertExists()
    compose.onNodeWithText("0: Post 0").assertDoesNotExist()
  }

  @Test fun `vertical collection exposes only composed rows in data order`() = verify("vertical")

  @Test
  fun `horizontal collection exposes only composed rows in data order`() = verify("horizontal")

  @Test
  fun `end action fires once per signature and resets on a new show`() {
    val data = mutableStateOf(PrototypeLazyListTest().spec(1))
    val epoch = mutableStateOf(0)
    val events = mutableListOf<PrototypeInteraction>()
    val action = PrototypeInteraction.Tap(listOf(PrototypeEmitAction("end")))
    compose.setContent {
      val original = data.value
      val spec =
        original.copy(
          root =
            (original.root as PrototypeListNode).copy(
              header = null,
              footer = null,
              refresh = null,
              onEndReached = action.actions,
              style =
                PrototypeStyle(
                  width = PrototypeDimension.Dp(200.0),
                  height = PrototypeDimension.Dp(200.0),
                ),
            ),
        )
      CompositionLocalProvider(
        LocalPrototypeFillsWindow provides true,
        LocalPrototypeMotion provides false,
        LocalPrototypeShowEpoch provides epoch.value,
      ) {
        Box(Modifier.fillMaxSize()) {
          PrototypeSpecContent(mapPrototypeSpec(spec).root) { events += it }
        }
      }
    }
    compose.waitForIdle()
    assertEquals(listOf(action), events)
    compose.runOnIdle {
      data.value =
        data.value.copy(state = mapOf("refreshing" to PrototypeScalar.BooleanValue(false)))
    }
    compose.waitForIdle()
    assertEquals(1, events.size)
    compose.runOnIdle { data.value = PrototypeLazyListTest().spec(2) }
    compose.waitForIdle()
    assertEquals(2, events.size)
    compose.runOnIdle { epoch.value++ }
    compose.waitForIdle()
    assertEquals(listOf(action, action, action), events)
  }
}
