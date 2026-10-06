package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The plan `tool:` allowlist follows `schemas/tool-definitions.json` (#10126). */
class ValidToolsTest {
  private val schemaToolNames: Set<String> =
    Json.parseToJsonElement(RepoFiles.find("schemas/tool-definitions.json").readText())
      .jsonArray
      .map { it.jsonObject.getValue("name").jsonPrimitive.content }
      .toSet()

  private fun unknownToolErrors(tool: String) =
    TestPlanValidator.validateYaml("name: p\nsteps:\n  - tool: $tool\n").errors.filter {
      it.message.startsWith("Unknown tool")
    }

  @Test
  fun `every tool in tool-definitions is accepted in a plan step`() {
    assertTrue(schemaToolNames.size > 80, "schema should list the full tool surface")
    val rejected = schemaToolNames.filter { unknownToolErrors(it).isNotEmpty() }
    assertEquals(emptyList(), rejected, "tools the daemon can run but the validator rejects")
  }

  @Test
  fun `accepted names are exactly the schema tools plus the migrated legacy names`() {
    assertEquals(schemaToolNames + ValidTools.MIGRATED_LEGACY_TOOLS, ValidTools.TOOLS)
  }

  @Test
  fun `tools removed from the registry are rejected`() {
    val removed =
      listOf(
        "captureDeviceSnapshot",
        "deleteSnapshot",
        "listSnapshots",
        "restoreDeviceSnapshot",
        "doctor",
        "pressKey",
        "startDevice",
      )
    for (tool in removed) {
      assertEquals(1, unknownToolErrors(tool).size, "$tool no longer exists and has no migration")
    }
  }

  @Test
  fun `legacy names the daemon migrates are still accepted`() {
    for (tool in ValidTools.MIGRATED_LEGACY_TOOLS) {
      assertEquals(emptyList(), unknownToolErrors(tool), "$tool is migrated by the daemon")
    }
  }

  @Test
  fun `the newly allowed tools from the issue pass validation of a whole plan`() {
    val result =
      TestPlanValidator.validateYaml(
        """
        name: unlock-and-tap
        steps:
          - tool: wakeAndUnlock
          - tool: tapAt
            x: 540
            y: 1200
        """
          .trimIndent()
      )
    assertEquals(emptyList(), result.errors)
    assertTrue(result.valid)
  }
}
