package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Typed daemon refusals cross the wire in the shapes captured in `test/fixtures/refusal-wire`
 * (generated from the real TypeScript builders). Every fixture must be classified as
 * `expectations.json` says; a recorded known gap pins the runner's current, divergent answer.
 */
class RefusalWireContractTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val dir = locateFixtureDir()

  @Test
  fun `every refusal fixture is classified as the shared expectations table says`() {
    val codes = json.parseToJsonElement(File(dir, "expectations.json").readText()).jsonObject
    val rows = codes.getValue("codes").jsonObject
    val fixtureFiles =
      dir.listFiles { f -> f.name.endsWith(".json") && f.name != "expectations.json" }!!
    assertEquals(rows.keys, fixtureFiles.map { it.name.removeSuffix(".json") }.toSet())
    for (file in fixtureFiles) {
      val code = file.name.removeSuffix(".json")
      val row = rows.getValue(code).jsonObject
      val expected = row.getValue("expected").jsonPrimitive.content
      val gap = row["knownGaps"]?.jsonObject?.get("kotlin")?.jsonPrimitive?.content
      val result = json.parseToJsonElement(file.readText()).jsonObject.getValue("result")
      val actual =
        AutoMobilePlanExecutor.classifyRefusal(
            DaemonResponse(id = code, type = "mcp_response", success = true, result = result),
            json,
          )
          .wire
      if (gap == null) {
        assertEquals(code, expected, actual)
      } else {
        assertTrue("$code: known gap must differ from the expectation", gap != expected)
        assertEquals("$code: known gap no longer matches; remove it", gap, actual)
      }
    }
  }

  private fun locateFixtureDir(): File {
    var current: File? = File("").absoluteFile
    while (current != null) {
      val candidate = File(current, "test/fixtures/refusal-wire")
      if (candidate.isDirectory) return candidate
      current = current.parentFile
    }
    error("test/fixtures/refusal-wire not found above ${File("").absolutePath}")
  }
}
