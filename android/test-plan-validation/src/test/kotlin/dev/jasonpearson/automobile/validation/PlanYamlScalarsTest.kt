package dev.jasonpearson.automobile.validation

import java.math.BigInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Plain scalars type the way the daemon's js-yaml core schema types them (#10129). The table is the
 * shared fixture `test/fixtures/plan-yaml/core-schema-scalars.json`; the TypeScript side
 * (`test/utils/plan/planYamlScalars.test.ts`) asserts the same rows against js-yaml.
 */
class PlanYamlScalarsTest {
  private data class Row(val yaml: String, val type: String, val value: String?)

  private val rows: List<Row> =
    Json.parseToJsonElement(
        RepoFiles.find("test/fixtures/plan-yaml/core-schema-scalars.json").readText()
      )
      .jsonArray
      .map {
        val row = it.jsonObject
        Row(
          yaml = row.getValue("yaml").jsonPrimitive.content,
          type = row.getValue("type").jsonPrimitive.content,
          value = row["value"]?.jsonPrimitive?.content,
        )
      }

  private fun load(scalar: String): Any? =
    PlanYaml.newLoader().load<Map<String, Any?>>("v: $scalar")["v"]

  private fun mismatch(row: Row, actual: Any?): String? =
    when (row.type) {
      "null" -> "expected null".takeIf { actual != null }
      "boolean" -> "expected boolean ${row.value}".takeUnless { actual == row.value?.toBoolean() }
      "string" -> "expected string ${row.value}".takeUnless { actual == row.value }
      "number" ->
        "expected number ${row.value}".takeUnless { actual is Number && sameNumber(actual, row) }
      else -> "unknown type ${row.type}"
    }

  private fun sameNumber(actual: Number, row: Row): Boolean {
    val want = row.value!!.toDouble()
    val got = actual.toDouble()
    return (want.isNaN() && got.isNaN()) || want == got
  }

  @Test
  fun `the table is broad`() {
    assertTrue(rows.size > 60, "expected a broad table, got ${rows.size} rows")
  }

  @Test
  fun `every scalar resolves to the type and value js-yaml produces`() {
    val mismatches = rows.mapNotNull { row ->
      val actual = load(row.yaml)
      mismatch(row, actual)?.let {
        "'${row.yaml}': $it, got ${actual?.javaClass?.simpleName}:$actual"
      }
    }
    assertEquals(emptyList(), mismatches)
  }

  @Test
  fun `an unquoted timestamp is not a Date`() {
    assertEquals("2026-01-08T00:00:00Z", load("2026-01-08T00:00:00Z"))
    assertEquals("2026-01-08", load("2026-01-08"))
  }

  @Test
  fun `quoted scalars stay strings`() {
    assertEquals("true", load("\"true\""))
    assertEquals("12", load("'12'"))
    assertEquals("", load("\"\""))
  }

  @Test
  fun `empty value is null and merge keys still merge`() {
    assertNull(load(""))
    val merged =
      PlanYaml.newLoader()
        .load<Map<String, Any?>>("base: &b\n  tool: tapOn\nstep:\n  <<: *b\n  label: x\n")
    assertEquals(mapOf("tool" to "tapOn", "label" to "x"), merged["step"])
  }

  @Test
  fun `integers keep exact precision across int long and big ranges`() {
    assertEquals(BigInteger("12345678901234567890"), load("12345678901234567890"))
    assertEquals(2147483648L, load("2147483648"))
    assertEquals(-5, load("-5"))
  }
}
