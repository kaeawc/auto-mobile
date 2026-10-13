package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot.validPrototypeFixture
import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The host's exact text lookup and clickable-ancestor promotion remain possible. */
@RunWith(RobolectricTestRunner::class)
class PrototypeSelectorCompatibilityTest {
  @Test
  fun `every benchmark scenario selector resolves exactly in its scenario state`() {
    val initial = benchmarkSemanticsSpec()
    val scenarios =
      Json.parseToJsonElement(
          prototypeRepositoryFile("benchmark/prototype-frame/scenarios.json").readText(),
        )
        .jsonArray
    val steps = scenarios.flatMap { it.jsonObject.getValue("steps").jsonArray }
    PrototypeSemanticsRender(initial).use { rendered ->
      steps
        .filter { it.jsonObject.getValue("text").jsonPrimitive.content != "Close overlay" }
        .forEach { assertStep(rendered, it.jsonObject) }
    }
    val open =
      initial.copy(
        state = initial.state.orEmpty() + ("overlay" to PrototypeScalar.BooleanValue(true)),
      )
    PrototypeSemanticsRender(open).use { rendered ->
      steps
        .filter { it.jsonObject.getValue("text").jsonPrimitive.content == "Close overlay" }
        .forEach { assertStep(rendered, it.jsonObject) }
    }
  }

  private fun assertStep(rendered: PrototypeSemanticsRender, step: JsonObject) {
    val text = step.getValue("text").jsonPrimitive.content
    val matches = rendered.nodes.filter { it.hasExactPrototypeText(text) }
    assertTrue("no exact scenario selector: $text", matches.isNotEmpty())
    if (step.getValue("tool").jsonPrimitive.content == "tapOn") {
      assertTrue(
        "no clickable ancestor for: $text",
        matches.any { node ->
          generateSequence(node) { it.parent }
            .any {
              it.config.contains(SemanticsActions.OnClick) ||
                it.config.getOrNull(SemanticsProperties.Role) == Role.Tab
            }
        },
      )
    }
  }

  @Test
  fun `acceptance selectors preserve tagged visuals text fields and button labels`() {
    PrototypeSemanticsRender(validPrototypeFixture("fullscreen-all-nodes")).use {
      assertHandles(it)
    }
    val tap = listOf<PrototypeAction>(PrototypeEmitAction("select"))
    val root =
      PrototypeColumnNode(
        testTag = "column",
        children =
          listOf(
            PrototypeIconNode(name = "home", testTag = "decorative-icon"),
            PrototypeImageNode(
              asset = PrototypeModeValue.Single("missing"),
              testTag = "decorative-image",
            ),
            PrototypeRowNode(
              testTag = "row",
              onTap = tap,
              children = listOf(PrototypeTextNode(text = "Tagged text", testTag = "tagged-text")),
            ),
            PrototypeTextFieldNode(stateKey = "query", testTag = "field"),
            PrototypeButtonNode(label = "Select C", testTag = "select-c", onTap = tap),
          ),
      )
    val spec = semanticsSpec(root).copy(state = mapOf("query" to PrototypeScalar.Text("")))
    PrototypeSemanticsRender(spec).use { rendered ->
      assertHandles(rendered)
      for (tag in
        listOf(
          "column",
          "decorative-icon",
          "decorative-image",
          "row",
          "tagged-text",
          "field",
          "select-c",
        )) {
        assertEquals(
          tag,
          1,
          rendered.nodes.count { it.config.getOrNull(SemanticsProperties.TestTag) == tag },
        )
      }
      val image =
        rendered.nodes.single {
          it.config.getOrNull(SemanticsProperties.TestTag) == "decorative-image"
        }
      assertEquals(Role.Image, image.config[SemanticsProperties.Role])
      assertNull(image.config.getOrNull(SemanticsProperties.ContentDescription))
      val icon =
        rendered.nodes.single {
          it.config.getOrNull(SemanticsProperties.TestTag) == "decorative-icon"
        }
      assertTrue(icon.hasExactPrototypeText("home"))
      val field =
        rendered.nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "field" }
      assertTrue(
        "sendKeys requires an editable field",
        field.config.contains(SemanticsActions.SetText),
      )
      assertStep(
        rendered,
        buildJsonObject {
          put("text", "Select C")
          put("tool", "tapOn")
        },
      )
    }
  }

  @Test
  fun `every visible composed text and tag remains an exact selector across fixtures`() {
    PrototypeSemanticsRender(benchmarkSemanticsSpec()).use { assertHandles(it) }
    for (name in
      listOf(
        "component-gallery",
        "content-description",
        "repeat-component-labels",
        "doc-example-2",
        "doc-example-1",
      )) {
      PrototypeSemanticsRender(validPrototypeFixture(name)).use { assertHandles(it) }
    }
  }

  private fun assertHandles(rendered: PrototypeSemanticsRender) {
    for (node in composedSelectorNodes(rendered.model.root)) {
      if (node.role == "text" && node.text.isNotEmpty()) {
        assertTrue(
          "${rendered.spec.id} ${node.identity}: missing exact text ${node.text}",
          rendered.nodes.any { it.hasExactPrototypeText(node.text) },
        )
      }
      node.testTag?.let { tag ->
        assertEquals(
          "${rendered.spec.id} ${node.identity}: tag $tag",
          1,
          rendered.nodes.count { it.config.getOrNull(SemanticsProperties.TestTag) == tag },
        )
      }
    }
  }

  private fun composedSelectorNodes(root: PrototypeRenderNode): List<PrototypeRenderNode> {
    val result = mutableListOf<PrototypeRenderNode>()
    val modals = modalPrototypeSheets(root)
    fun visit(node: PrototypeRenderNode, modalRoot: Boolean = false) {
      if (!node.visible) return // Invisible nodes and their descendants are not composed initially.
      // Modals are hoisted; closed ones are not composed.
      if (node.role in PROTOTYPE_MODAL_ROLES && !modalRoot) return
      result += node
      if (node.role == "pager") {
        node.children.getOrNull(node.page)?.let {
          visit(it)
        } // Offscreen pages clear their semantics.
      } else {
        node.children.forEach { visit(it) }
      }
    }
    // An open dialog clears the background page semantics.
    if (modals.none { it.role == "dialog" }) visit(root)
    modals.forEach { visit(it, modalRoot = true) }
    return result
  }
}
