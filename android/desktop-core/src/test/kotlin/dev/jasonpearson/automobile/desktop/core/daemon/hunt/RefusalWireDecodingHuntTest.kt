package dev.jasonpearson.automobile.desktop.core.daemon.hunt

import dev.jasonpearson.automobile.desktop.core.daemon.McpToolErrorException
import dev.jasonpearson.automobile.desktop.core.daemon.SetActiveDeviceRefusal
import dev.jasonpearson.automobile.desktop.core.daemon.SetActiveDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.classifySetActiveDeviceRefusal
import dev.jasonpearson.automobile.desktop.core.daemon.decodeToolResponse
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

/**
 * Hunt: the desktop client against the real refusal shapes captured in `test/fixtures/refusal-wire`
 * (generated from the daemon's serializers). Pure decoding; no socket, no daemon.
 */
class RefusalWireDecodingHuntTest {
  private val json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
  }

  private fun fixtureResult(name: String): JsonElement =
    json
      .parseToJsonElement(File(fixtureDir(), "$name.json").readText())
      .jsonObject
      .getValue("result")

  private fun fixtureText(name: String): String =
    fixtureResult(name)
      .jsonObject
      .getValue("content")
      .jsonArray
      .first()
      .jsonObject
      .getValue("text")
      .jsonPrimitive
      .content

  /** Refusals whose payload nests the typed fields under `error`. */
  private val nestedCodes =
    listOf(
      "session_ownership_lost",
      "no_active_device_session",
      "daemon_session_suspect",
      "daemon_shutting_down",
      "discovery_incomplete",
    )

  private fun decodeFailure(name: String): McpToolErrorException =
    try {
      decodeToolResponse(json, fixtureResult(name), serializer<SetActiveDeviceResult>())
      fail("$name: expected a tool error")
    } catch (e: McpToolErrorException) {
      e
    }

  @Test
  fun `a tools-call refusal that nests its typed code under error keeps the code`() {
    val lost = nestedCodes.mapNotNull { code ->
      decodeFailure(code).let { if (it.code != code) "$code (decoded code=${it.code})" else null }
    }
    assertTrue(lost.isEmpty(), "typed code lost for nested refusals: $lost")
  }

  @Test
  fun `a nested refusal surfaces its message, not the raw JSON payload`() {
    val expected =
      json
        .parseToJsonElement(fixtureText("session_ownership_lost"))
        .jsonObject
        .getValue("error")
        .jsonObject
        .getValue("message")
        .jsonPrimitive
        .content
    assertEquals(expected, decodeFailure("session_ownership_lost").message)
  }

  @Test
  fun `a bind refused with nextAction acquire_new_session is a released session`() {
    val unclassified = mutableListOf<String>()
    for (code in listOf("session_terminal_release_in_progress", "no_active_device_session")) {
      val payload = json.parseToJsonElement(fixtureText(code)).jsonObject
      val nextAction =
        (payload["nextAction"] ?: (payload["error"] as? JsonObject)?.get("nextAction"))
          ?.jsonPrimitive
          ?.content
      assertEquals("acquire_new_session", nextAction, "$code: fixture premise")
      val refusal = classifySetActiveDeviceRefusal(json, fixtureResult(code))
      if (refusal != SetActiveDeviceRefusal.SESSION_RELEASED) unclassified += "$code -> $refusal"
    }
    assertTrue(
      unclassified.isEmpty(),
      "terminal refusals not classified as SESSION_RELEASED (the loop would resend the dead " +
        "UUID): $unclassified",
    )
  }

  private fun fixtureDir(): File {
    var current: File? = File("").absoluteFile
    while (current != null) {
      val candidate = File(current, "test/fixtures/refusal-wire")
      if (candidate.isDirectory) return candidate
      current = current.parentFile
    }
    error("test/fixtures/refusal-wire not found")
  }
}
