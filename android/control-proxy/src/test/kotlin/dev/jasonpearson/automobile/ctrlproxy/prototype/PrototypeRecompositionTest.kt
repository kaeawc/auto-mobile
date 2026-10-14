package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeRecompositionTest {
  @get:Rule val compose = createComposeRule()

  private val host = FakePrototypeHost()
  private val events = mutableListOf<PrototypeEvent>()
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { _, _, _ -> },
      eventSink = PrototypeEventSink { events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
    )

  private fun spec(root: PrototypeNode) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf("a" to PrototypeScalar.BooleanValue(false), "query" to PrototypeScalar.Text("kept")),
      root,
      motion = "none",
    )

  private fun show(root: PrototypeNode): PrototypeRuntime {
    runTest { controller.show("show", spec(root)) }
    return checkNotNull(controller.activeRuntime)
  }

  private fun toggle(runtime: PrototypeRuntime) {
    compose.runOnIdle { runTest { controller.interact(runtime, PrototypeInteraction.Toggle("a")) } }
    compose.waitForIdle()
  }

  private fun patchData(ops: String) {
    compose.runOnIdle {
      runTest { controller.patch("patch", "panel", null, Json.parseToJsonElement(ops).jsonArray) }
    }
    compose.waitForIdle()
  }

  @Test
  fun `patching one keyed data row recomposes only that rows identities`() {
    val root =
      PrototypeColumnNode(
        repeat = PrototypeRepeat(emptyList(), "item", itemsPath = "/items", key = "id"),
        children =
          listOf(PrototypeBoxNode(children = listOf(PrototypeTextNode(text = "{item.title}")))),
      )
    val data =
      Json.parseToJsonElement(
          """{"items":[{"id":"a","title":"A"},{"id":"b","title":"B"},{"id":"c","title":"C"},{"id":"d","title":"D"}]}""",
        )
        .jsonObject
    runTest { controller.show("show", spec(root).copy(data = data)) }
    val runtime = checkNotNull(controller.activeRuntime)
    val counts = mutableMapOf<String, Int>()
    val probe: (String) -> Unit = { identity -> counts[identity] = (counts[identity] ?: 0) + 1 }
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeCompositionProbe provides probe) {
        PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) }
      }
    }
    compose.waitForIdle()
    val before = counts.toMap()
    patchData("""[{"op":"replace","path":"/data/items/1/title","value":"B changed"}]""")
    compose.onNodeWithText("B changed").assertIsDisplayed()
    compose.runOnIdle {
      for (key in listOf("a", "c", "d")) {
        val row = "root.repeat[$key].children[0]"
        assertNotNull(before[row])
        assertEquals(row, before[row], counts[row])
        assertEquals(row, before["$row.children[0]"], counts["$row.children[0]"])
      }
      val changed = "root.repeat[b].children[0]"
      assertEquals(checkNotNull(before[changed]) + 1, counts[changed])
      assertEquals(checkNotNull(before["$changed.children[0]"]) + 1, counts["$changed.children[0]"])
    }
  }

  @Test
  fun `reordered keyed fields retain typed state focus and skip moved unchanged rows`() {
    val root =
      PrototypeColumnNode(
        repeat = PrototypeRepeat(emptyList(), "item", itemsPath = "/items", key = "id"),
        children = listOf(PrototypeTextFieldNode(stateKey = "note_{item.id}")),
      )
    val data = Json.parseToJsonElement("""{"items":[{"id":"a"},{"id":"b"}]}""").jsonObject
    val state =
      mapOf("note_a" to PrototypeScalar.Text("A note"), "note_b" to PrototypeScalar.Text("B note"))
    runTest { controller.show("show", spec(root).copy(state = state, data = data)) }
    val runtime = checkNotNull(controller.activeRuntime)
    val counts = mutableMapOf<String, Int>()
    val probe: (String) -> Unit = { identity -> counts[identity] = (counts[identity] ?: 0) + 1 }
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeCompositionProbe provides probe) {
        PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) }
      }
    }
    compose.onNodeWithText("A note").performClick().performTextReplacement("A typed")
    compose.waitForIdle()
    val before = counts.toMap()
    patchData("""[{"op":"replace","path":"/data","value":{"items":[{"id":"b"},{"id":"a"}]}}]""")
    compose.onNodeWithText("A typed").assertIsFocused().assertTextEquals("A typed")
    compose.onNodeWithText("B note").assertTextEquals("B note")
    compose.runOnIdle {
      for (key in listOf("a", "b")) {
        val row = "root.repeat[$key].children[0]"
        assertNotNull(before[row])
        assertEquals(row, before[row], counts[row])
      }
      assertEquals(PrototypeScalar.Text("A typed"), runtime.current.state["note_a"])
    }
  }

  @Test
  fun `data only patch keeps unrelated fields focus and live typed text`() {
    val root =
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeTextNode(testTag = "data", text = "{data:/title}"),
            PrototypeTextFieldNode(testTag = "field", stateKey = "query"),
          ),
      )
    runTest {
      controller.show("show", spec(root).copy(data = buildJsonObject { put("title", "old") }))
    }
    val runtime = checkNotNull(controller.activeRuntime)
    compose.setContent { PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) } }
    compose.onNodeWithTag("field").performClick().performTextReplacement("kept typed")
    compose.waitForIdle()
    patchData("""[{"op":"replace","path":"/data/title","value":"new"}]""")
    compose.onNodeWithTag("data").assertTextEquals("new")
    compose.onNodeWithTag("field").assertIsFocused().assertTextEquals("kept typed")
    assertEquals(PrototypeScalar.Text("kept typed"), runtime.current.state["query"])
  }

  @Test
  fun `one interaction maps once across controller metadata and composition and skips independent nodes`() {
    val children =
      List(4) { index ->
        PrototypeBoxNode(
          children = listOf(PrototypeTextNode(text = if (index == 1) "{a}" else "constant $index")),
        )
      }
    val runtime = show(PrototypeColumnNode(children = children))
    val counts = mutableMapOf<String, Int>()
    val probe: (String) -> Unit = { identity -> counts[identity] = (counts[identity] ?: 0) + 1 }
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeCompositionProbe provides probe) {
        PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) }
      }
    }
    compose.waitForIdle()
    val before = counts.toMap()
    val passes = runtime.renderMappingPasses
    toggle(runtime)
    compose.runOnIdle {
      assertNotNull(controller.windowMetadata())
      assertEquals(passes + 1, runtime.renderMappingPasses)
      for (index in listOf(0, 2, 3)) {
        val identity = "root.children[$index]"
        assertEquals(identity, before[identity], counts[identity])
        assertEquals(identity, before["$identity.children[0]"], counts["$identity.children[0]"])
      }
      for (identity in listOf("root", "root.children[1]", "root.children[1].children[0]")) {
        assertEquals(identity, checkNotNull(before[identity]) + 1, counts[identity])
      }
      assertEquals(3, counts.count { (identity, count) -> count != before[identity] })
    }
  }

  @Test
  fun `host and content share one stable scheme and retheme when the leading background changes`() {
    val dark = PrototypeCondition("query", PrototypeScalar.Text("dark"))
    val root =
      PrototypeColumnNode(
        style = PrototypeStyle(background = PrototypeModeValue.Single("#FFFFFF")),
        styleWhen =
          listOf(
            PrototypeStyleWhen(
              dark,
              PrototypeStyle(background = PrototypeModeValue.Single("#101010")),
            ),
          ),
        children = listOf(PrototypeTextNode(text = "{a}")),
      )
    val runtime = show(root)
    val flow = checkNotNull(host.requests.last().theme)
    var hostScheme: ColorScheme? = null
    var contentScheme: ColorScheme? = null
    compose.setContent {
      val shown by flow.collectAsState()
      val snapshot by runtime.snapshots.collectAsState()
      PrototypeHostTheme(shown) {
        hostScheme = MaterialTheme.colorScheme
        // The content's wrapper must still run, even when it borrows the host's palette.
        PrototypeTheme(runtime.renderModel(snapshot).root, snapshot.spec.theme) {
          contentScheme = MaterialTheme.colorScheme
          PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) }
        }
      }
    }
    compose.waitForIdle()
    val original = hostScheme
    val originalTheme = flow.value
    assertNotNull(original)
    assertSame(original, contentScheme)
    toggle(runtime)
    compose.runOnIdle {
      assertSame(originalTheme, flow.value)
      assertSame(original, hostScheme)
      assertSame(original, contentScheme)
      assertTrue(events.none { it.kind == PrototypeEventKind.APPEARANCE_CHANGED })
      runTest { controller.interact(runtime, PrototypeInteraction.TextChange("query", "dark")) }
    }
    compose.waitForIdle()
    compose.runOnIdle {
      assertNotSame(original, hostScheme)
      assertSame(hostScheme, contentScheme)
      val model = runtime.renderModel()
      val expected = prototypeColorScheme(prototypeThemeSpecFor(model.root, model.theme, true))
      assertEquals(Color(0xff101010), contentScheme?.surface)
      assertEquals(expected.toString(), contentScheme.toString())
      assertEquals(1, events.count { it.kind == PrototypeEventKind.APPEARANCE_CHANGED })
    }
  }

  @Test
  fun `visibility and placeholders update while an unrelated field retains text and focus`() {
    val root =
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeTextNode(
              testTag = "visible",
              text = "shown",
              visibleWhen = PrototypeCondition("a", PrototypeScalar.BooleanValue(true)),
            ),
            PrototypeTextNode(testTag = "placeholder", text = "{a}"),
            PrototypeTextFieldNode(testTag = "field", stateKey = "query"),
          ),
      )
    val runtime = show(root)
    compose.setContent { PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) } }
    compose.onAllNodesWithTag("visible").assertCountEquals(0)
    compose.onNodeWithTag("placeholder").assertTextEquals("false")
    compose.onNodeWithTag("field").performClick().performTextReplacement("kept typed")
    compose.waitForIdle()
    compose.onNodeWithTag("field").assertIsFocused().assertTextEquals("kept typed")
    toggle(runtime)
    compose.onNodeWithTag("visible").assertIsDisplayed()
    compose.onNodeWithTag("placeholder").assertTextEquals("true")
    compose.onNodeWithTag("field").assertIsFocused().assertTextEquals("kept typed")
    toggle(runtime)
    compose.onAllNodesWithTag("visible").assertCountEquals(0)
    compose.onNodeWithTag("placeholder").assertTextEquals("false")
    compose.onNodeWithTag("field").assertIsFocused().assertTextEquals("kept typed")
  }
}
