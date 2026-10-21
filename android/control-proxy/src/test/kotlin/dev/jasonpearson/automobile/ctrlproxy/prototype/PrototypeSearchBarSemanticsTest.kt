package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeSearchBarSemanticsTest {
  private val interactions = mutableListOf<PrototypeInteraction>()
  private val submit = listOf<PrototypeAction>(PrototypeEmitAction("search"))
  private val clear =
    listOf<PrototypeAction>(PrototypeSetStateAction("query", PrototypeScalar.Text("")))

  private fun spec(variant: String, active: Boolean) =
    PrototypeSpec(
      "search",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf("query" to PrototypeScalar.Text(""), "active" to PrototypeScalar.BooleanValue(active)),
      PrototypeSearchBarNode(
        stateKey = "query",
        activeKey = "active",
        variant = variant,
        testTag = "search",
        contentDescription = "Find items",
        placeholder = "Search items",
        leadingIcon = "search",
        onSubmit = submit,
        trailingActions = listOf(PrototypeAppBarAction("close", "Clear query", clear)),
        child =
          PrototypeColumnNode(
            children = List(5) { PrototypeTextNode(testTag = "result.$it", text = "Result $it") },
          ),
      ),
    )

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun SemanticsNode.find(predicate: (SemanticsNode) -> Boolean): SemanticsNode? =
    if (predicate(this)) this else children.firstNotNullOfOrNull { it.find(predicate) }

  private fun SemanticsNode.tagged(tag: String): SemanticsNode? = find {
    it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag
  }

  private fun withTree(spec: PrototypeSpec, check: (SemanticsNode) -> Unit) {
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    try {
      activity.get().setContent {
        PrototypeSpecContent(mapPrototypeSpec(spec).root) { interactions += it }
      }
      shadowOf(Looper.getMainLooper()).idle()
      val view = checkNotNull(composeView(activity.get().window.decorView)) as RootForTest
      check(view.semanticsOwner.rootSemanticsNode)
    } finally {
      activity.pause().stop().destroy()
    }
  }

  @Test
  fun `bar and docked expose all five result rows only while active`() {
    for (variant in listOf("bar", "docked")) {
      for (active in listOf(false, true)) {
        withTree(spec(variant, active)) { root ->
          for (index in 0 until 5) {
            if (active) assertNotNull(root.tagged("result.$index"))
            else assertNull(root.tagged("result.$index"))
          }
          val field = checkNotNull(root.find { it.config.contains(SemanticsActions.SetText) })
          assertEquals("search", field.config[SemanticsProperties.TestTag])
          assertEquals(true, checkNotNull(field.config[SemanticsActions.RequestFocus].action)())
          assertTrue(interactions.isEmpty())
        }
      }
    }
    assertTrue(interactions.isEmpty()) // Rendering or focusing must never activate results.
  }

  @Test
  fun `IME editing search submission and trailing tap use the controller dispatch path`() =
    runTest {
      val events = mutableListOf<PrototypeEvent>()
      val controller =
        PrototypeController(
          FakePrototypeHost(),
          PrototypeResultSink { _, _, _ -> },
          eventSink = PrototypeEventSink { events += it },
          clock = { 42L },
          lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        )
      val spec = spec("docked", false)
      controller.show("show", spec)
      val runtime = checkNotNull(controller.activeRuntime)
      withTree(spec) { root ->
        val field = checkNotNull(root.find { it.config.contains(SemanticsActions.SetText) })
        assertTrue(
          field.config
            .getOrElse(SemanticsProperties.ContentDescription) { emptyList() }
            .contains("Find items"),
        )
        assertEquals(ImeAction.Search, field.config[SemanticsProperties.ImeAction])
        assertEquals(
          true,
          checkNotNull(field.config[SemanticsActions.SetText].action)(AnnotatedString("coffee")),
        )
        assertEquals(true, checkNotNull(field.config[SemanticsActions.OnImeAction].action)())
        val trailing = checkNotNull(root.tagged("search.actions.0"))
        assertEquals(listOf("Clear query"), trailing.config[SemanticsProperties.ContentDescription])
        assertEquals(true, checkNotNull(trailing.config[SemanticsActions.OnClick].action)())
      }
      assertEquals(
        listOf(
          PrototypeInteraction.TextChange("query", "coffee", 0),
          PrototypeInteraction.Tap(submit),
          PrototypeInteraction.Tap(clear),
        ),
        interactions,
      )
      controller.interact(runtime, interactions[0])
      assertEquals(PrototypeScalar.Text("coffee"), runtime.current.state["query"])
      assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["active"])
      assertEquals(PrototypeEventKind.EMIT, events.single().kind)
      assertEquals("change", events.single().name)
      assertEquals(
        Json.parseToJsonElement("""{"key":"query","value":"coffee"}"""),
        events.single().payload,
      )
      controller.interact(runtime, interactions[1])
      assertEquals("search", events.last().name)
      controller.interact(runtime, interactions[2])
      assertEquals(PrototypeScalar.Text(""), runtime.current.state["query"])
    }
}
