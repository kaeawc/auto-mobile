package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Verdicts for the highlight / dragAndDrop / setDeviceState plan steps (#10124, #10125). The table
 * is the shared fixture `test/fixtures/plan-yaml/step-verdicts.json`; the TypeScript validator
 * asserts the same rows in `test/plan/planStepVerdictsParity.test.ts`.
 */
class PlanStepVerdictsParityTest {
  private data class Row(val name: String, val valid: Boolean, val yaml: String)

  private val rows: List<Row> =
    Json.parseToJsonElement(RepoFiles.find("test/fixtures/plan-yaml/step-verdicts.json").readText())
      .jsonArray
      .map {
        val row = it.jsonObject
        Row(
          name = row.getValue("name").jsonPrimitive.content,
          valid = row.getValue("valid").jsonPrimitive.boolean,
          yaml = row.getValue("yaml").jsonPrimitive.content,
        )
      }

  @Test
  fun `the table covers accepted and rejected snippets of all three tools`() {
    assertTrue(rows.any { it.valid } && rows.any { !it.valid })
    listOf("highlight", "dragAndDrop", "setDeviceState").forEach { tool ->
      assertTrue(rows.any { it.yaml.contains("tool: $tool") }, "no row for $tool")
    }
  }

  @Test
  fun `every row gets the verdict the TypeScript validator gives`() {
    val mismatches = rows.mapNotNull { row ->
      val result = TestPlanValidator.validateYaml(row.yaml)
      "${row.name}: expected valid=${row.valid}, got ${result.valid} ${result.errors}"
        .takeIf {
          result.valid != row.valid
        }
    }
    assertEquals(emptyList(), mismatches)
  }
}
