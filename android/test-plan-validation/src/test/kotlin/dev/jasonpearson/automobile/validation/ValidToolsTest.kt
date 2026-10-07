package dev.jasonpearson.automobile.validation

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ValidToolsTest {

  private fun registryToolNames(): Set<String> {
    var current: Path? = Paths.get("").toAbsolutePath()
    var file: Path? = null
    repeat(6) {
      val candidate = current?.resolve("schemas/tool-definitions.json")
      if (file == null && candidate != null && Files.exists(candidate)) file = candidate
      current = current?.parent
    }
    val path = file ?: error("Unable to locate schemas/tool-definitions.json")
    return Json.parseToJsonElement(Files.readString(path))
      .jsonArray
      .map { it.jsonObject.getValue("name").jsonPrimitive.content }
      .toSet()
  }

  @Test
  fun `registry tool list matches tool-definitions json exactly`() {
    val expected = registryToolNames()
    assertEquals(
      emptySet(),
      expected - ValidTools.REGISTRY_TOOLS,
      "Tools in schemas/tool-definitions.json missing from ValidTools.REGISTRY_TOOLS",
    )
    assertEquals(
      emptySet(),
      ValidTools.REGISTRY_TOOLS - expected,
      "ValidTools.REGISTRY_TOOLS names that are not in schemas/tool-definitions.json",
    )
  }

  @Test
  fun `every registry tool passes unknown-tool validation`() {
    for (name in registryToolNames()) {
      val result =
        TestPlanValidator.validateYaml("{\"name\":\"p\",\"steps\":[{\"tool\":\"$name\"}]}")
      assertFalse(
        result.errors.any { it.message.contains("Unknown tool") },
        "'$name' rejected as unknown",
      )
    }
  }

  @Test
  fun `removed tools and unknown names are still rejected`() {
    for (name in listOf("doctor", "pressKey", "startDevice", "notATool")) {
      val result =
        TestPlanValidator.validateYaml("{\"name\":\"p\",\"steps\":[{\"tool\":\"$name\"}]}")
      assertTrue(result.errors.any { it.message.contains("Unknown tool") }, name)
    }
  }
}
