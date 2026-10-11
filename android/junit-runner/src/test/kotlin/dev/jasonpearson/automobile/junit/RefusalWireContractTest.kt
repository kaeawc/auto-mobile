package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
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
      val response =
        DaemonResponse(id = code, type = "mcp_response", success = true, result = result)
      assertFields(code, row.getValue("fields").jsonObject, response, result)
      val actual = AutoMobilePlanExecutor.classifyRefusal(response, json).wire
      if (gap == null) {
        assertEquals(code, expected, actual)
      } else {
        assertTrue("$code: known gap must differ from the expectation", gap != expected)
        assertEquals("$code: known gap no longer matches; remove it", gap, actual)
      }
    }
  }

  /**
   * A failed socket frame (`mcpRequestFailureDetails`) carries the typed fields at the top level,
   * not in a tool result (#11544): the runner must classify it as the surfaces table says.
   */
  @Test
  fun `every failed socket frame is classified as the surfaces expectations say`() {
    val surfaces = File(dir, "surfaces")
    val rows = json.parseToJsonElement(File(surfaces, "expectations.json").readText())
    var checked = 0
    for ((stem, row) in rows.jsonObject.getValue("fixtures").jsonObject) {
      if (!stem.startsWith("socket-frame.")) continue
      val payload =
        json
          .parseToJsonElement(File(surfaces, "$stem.json").readText())
          .jsonObject
          .getValue("payload")
      val response =
        json.decodeFromString(DaemonResponse.serializer(), withId(payload.jsonObject, stem))
      val fields = row.jsonObject.getValue("fields").jsonObject
      val evidence = AutoMobilePlanExecutor.refusalEvidence(response, json)
      assertEquals("$stem: code", fields["code"]?.jsonPrimitive?.content, evidence.code)
      assertEquals(
        "$stem: retryable",
        fields.getValue("retryable").jsonPrimitive.boolean,
        evidence.retryable,
      )
      assertEquals(
        "$stem: acquireNewSession",
        fields.getValue("acquireNewSession").jsonPrimitive.boolean,
        evidence.acquireNewSession,
      )
      assertEquals(
        "$stem: retryAfterMs",
        fields["retryAfterMs"]?.jsonPrimitive?.long,
        evidence.retryAfterMs,
      )
      assertEquals(
        stem,
        row.jsonObject.getValue("expected").jsonPrimitive.content,
        AutoMobilePlanExecutor.classifyRefusal(response, json).wire,
      )
      checked++
    }
    assertTrue("socket-frame rows were not found", checked > 0)
  }

  @Test
  fun `a retryAfterMs hint is usable as the shared hints table says`() {
    for (row in hintRows("usableHints")) {
      val wire = row.getValue("wire")
      val usable = row.getValue("usable").longOrNullOrNull()
      assertEquals(row.name(), usable, AutoMobilePlanExecutor.retryAfterHintMs(wire))
      val frame = DaemonResponse("hint", "mcp_response", false, retryAfterMs = wire)
      assertEquals(
        row.name(),
        usable,
        AutoMobilePlanExecutor.refusalEvidence(frame, json).retryAfterMs,
      )
    }
  }

  @Test
  fun `the next device wait is the shared hints table answer and never overflows`() {
    for (row in hintRows("backoffSteps")) {
      assertEquals(
        row.name(),
        row.getValue("delayMs").longOrNullOrNull(),
        AutoMobilePlanExecutor.deviceOwnedBackoffDelayMs(
          row.getValue("waits").jsonPrimitive.long.toInt(),
          row.getValue("waitedMs").jsonPrimitive.long,
          row.getValue("retryAfterMs").longOrNullOrNull(),
          row.getValue("code").jsonPrimitive.content,
        ),
      )
    }
  }

  private fun hintRows(key: String): List<JsonObject> =
    json
      .parseToJsonElement(File(File(dir.parentFile, "refusal-wire-hints"), "hints.json").readText())
      .jsonObject
      .getValue(key)
      .jsonArray
      .map { it.jsonObject }

  private fun JsonObject.name(): String = getValue("name").jsonPrimitive.content

  private fun JsonElement.longOrNullOrNull(): Long? =
    if (this is JsonNull) null else (this as JsonPrimitive).longOrNull

  private fun withId(payload: JsonObject, id: String): String =
    json.encodeToString(JsonObject.serializer(), JsonObject(payload + ("id" to JsonPrimitive(id))))

  /** The runner reads the code, retryable, nextAction and retryAfterMs the expectations pin. */
  private fun assertFields(
    code: String,
    fields: JsonObject,
    response: DaemonResponse,
    result: JsonElement,
  ) {
    val evidence = AutoMobilePlanExecutor.refusalEvidence(response, json)
    assertEquals("$code: code", fields["code"]?.jsonPrimitive?.content, evidence.code)
    assertEquals(
      "$code: retryable",
      fields.getValue("retryable").jsonPrimitive.boolean,
      evidence.retryable,
    )
    assertEquals(
      "$code: acquireNewSession",
      fields.getValue("acquireNewSession").jsonPrimitive.boolean,
      evidence.acquireNewSession,
    )
    assertEquals(
      "$code: retryAfterMs",
      fields["retryAfterMs"]?.jsonPrimitive?.long,
      evidence.retryAfterMs,
    )
    // The runner does not act on externalDevices; the wire must still carry the pinned list.
    val text =
      result.jsonObject
        .getValue("content")
        .jsonArray
        .first()
        .jsonObject
        .getValue("text")
        .jsonPrimitive
        .content
    assertEquals(
      "$code: externalDevices",
      fields["externalDevices"],
      json.parseToJsonElement(text).jsonObject["externalDevices"],
    )
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
