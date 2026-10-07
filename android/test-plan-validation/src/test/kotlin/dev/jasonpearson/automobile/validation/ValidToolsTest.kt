package dev.jasonpearson.automobile.validation

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ValidToolsTest {
  private fun registryToolNames(): Set<String> {
    val text = Files.readString(findToolDefinitions())
    return Json.parseToJsonElement(text)
      .jsonArray
      .map { it.jsonObject.getValue("name").jsonPrimitive.content }
      .toSet()
  }

  private fun findToolDefinitions(): Path {
    var current: Path? = Paths.get("").toAbsolutePath()
    repeat(6) {
      val candidate = current?.resolve("schemas/tool-definitions.json")
      if (candidate != null && Files.exists(candidate)) return candidate
      current = current?.parent
    }
    error("Unable to locate schemas/tool-definitions.json")
  }

  @Test
  fun `every registered tool is accepted`() {
    assertEquals(emptySet(), registryToolNames() - ValidTools.TOOLS)
  }

  @Test
  fun `only migrated legacy names are accepted beyond the registry`() {
    assertEquals(ValidTools.MIGRATED_LEGACY_TOOLS, ValidTools.TOOLS - registryToolNames())
  }
}
