package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeFrameBenchmarkSpecTest {
  private val directory =
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, "benchmark/prototype-frame") }
      .first { File(it, "spec.json").isFile }

  private fun nodes(root: PrototypeRenderNode): List<PrototypeRenderNode> =
    listOf(root) + root.children.flatMap { nodes(it) }

  @Test
  fun `benchmark validates expands and scenario targets drive authored state`() = runTest {
    val validation = PrototypeSpecValidator.validate(File(directory, "spec.json").readText())
    assertTrue(validation.toString(), validation is PrototypeSpecValidation.Success)
    val spec = (validation as PrototypeSpecValidation.Success).spec
    val rendered = nodes(mapPrototypeSpec(spec).root)
    assertEquals("perf-benchmark", spec.id)
    assertTrue(spec.window.placement is PrototypeFullscreenPlacement)
    assertTrue("render nodes: ${rendered.size}", rendered.size in 800..1000)
    assertTrue(rendered.count { it.source is PrototypeImageNode } >= 30)
    assertTrue(rendered.count { it.source?.visibleWhen != null } >= 70)
    val pager = rendered.single { it.source is PrototypePagerNode }
    assertEquals(4, pager.children.size)

    val targets =
      rendered.flatMap { node ->
        listOfNotNull(node.text, node.contentDescription) +
          (node.source as? PrototypeTabBarNode)?.items.orEmpty().map { it.label }
      }.toSet()
    val scenarios = Json.parseToJsonElement(File(directory, "scenarios.json").readText()).jsonArray
    assertEquals(
      listOf("idle", "tab-switch", "section-collapse", "pager-swipe", "scroll", "overlay-open", "three-write-tap"),
      scenarios.map { it.jsonObject.getValue("name").jsonPrimitive.content },
    )
    scenarios.forEach { scenario ->
      scenario.jsonObject.getValue("steps").jsonArray.forEach { step ->
        val target = step.jsonObject.getValue("text").jsonPrimitive.content
        assertTrue("missing scenario target: $target", target in targets)
      }
    }
    val threeWrite = rendered.single { it.text == "three-write tap" }.source as PrototypeButtonNode
    assertEquals(3, threeWrite.onTap!!.size)
    assertTrue(threeWrite.onTap!!.all { it is PrototypeIncrementAction })

    val runtime = PrototypeRuntime(spec, nextSequence = { 0L })
    val tab = rendered.single { it.source is PrototypeTabBarNode }.source as PrototypeTabBarNode
    runtime.handle(PrototypeInteraction.Select(null, tab.stateKey, 1))
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["tab"])
    val collapse = rendered.single { it.text == "Toggle section" }.source as PrototypeButtonNode
    runtime.handle(PrototypeInteraction.Tap(collapse.onTap!!))
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["section"])
    runtime.handle(PrototypeInteraction.Tap(threeWrite.onTap!!))
    listOf("first", "second", "third").forEachIndexed { index, key ->
      assertEquals(PrototypeScalar.Numeric((index + 1).toDouble()), runtime.current.state[key])
    }
  }
}
