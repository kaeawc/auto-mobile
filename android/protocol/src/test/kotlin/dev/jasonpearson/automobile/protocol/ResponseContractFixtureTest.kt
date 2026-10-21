package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test

/**
 * Encodes representative CtrlProxy replies with the real [WebSocketResponse] serializer, configured
 * exactly like the device's `responseJson` in `WebSocketServer`, so the host's behavioural contract
 * (`test/contracts/AndroidCtrlProxyContract.ts`) replays captured bytes instead of hand-written
 * ones. Timestamps are fixed and `requestId` is a placeholder the replaying socket substitutes.
 */
class ResponseContractFixtureTest {
  private val deviceJson = Json {
    prettyPrint = false
    encodeDefaults = true
    classDiscriminator = "type"
  }

  private val fixtureJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
  }

  private val timestamp = 1_700_000_000_000L
  private val requestId = "fixture-request-id"

  private val replies: List<Pair<String, WebSocketResponse>> =
    listOf(
      "tap_coordinates_result" to
        TapCoordinatesResult(
          timestamp = timestamp,
          requestId = requestId,
          success = true,
          totalTimeMs = 42,
          gestureTimeMs = 10,
        ),
      "tap_coordinates_refused" to
        TapCoordinatesResult(
          timestamp = timestamp,
          requestId = requestId,
          success = false,
          totalTimeMs = 7,
          error = "Gesture dispatch was cancelled",
        ),
      "swipe_result" to
        SwipeResult(
          timestamp = timestamp,
          requestId = requestId,
          success = true,
          totalTimeMs = 330,
          gestureTimeMs = 300,
        ),
      "swipe_refused" to
        SwipeResult(
          timestamp = timestamp,
          requestId = requestId,
          success = false,
          totalTimeMs = 5,
          error = "Gesture dispatch was cancelled",
        ),
      "drag_result" to
        DragResult(
          timestamp = timestamp,
          requestId = requestId,
          success = true,
          totalTimeMs = 900,
          gestureTimeMs = 600,
        ),
      "global_action_result" to
        GlobalActionResult(
          timestamp = timestamp,
          requestId = requestId,
          success = true,
          action = "back",
          totalTimeMs = 12,
        ),
      "global_action_refused" to
        GlobalActionResult(
          timestamp = timestamp,
          requestId = requestId,
          success = false,
          action = "back",
          totalTimeMs = 3,
          error = "Global action back was not performed",
        ),
      "error_decode_failed" to
        ErrorResponse(
          timestamp = timestamp,
          requestId = requestId,
          error = "Failed to decode request_swipe: missing field x2",
        ),
    )

  @Test
  fun responseContractFixture() {
    val fixture = buildJsonObject {
      put(
        "responses",
        JsonArray(
          replies.map { (name, response) ->
            buildJsonObject {
              put("name", name)
              put(
                "wire",
                deviceJson.parseToJsonElement(
                  deviceJson.encodeToString(WebSocketResponse.serializer(), response),
                ),
              )
            }
          },
        ),
      )
    }
    val generated = fixtureJson.encodeToString(JsonElement.serializer(), fixture) + "\n"
    val output = System.getenv("AUTOMOBILE_FIXTURE_OUT_DIR")
    if (output != null) {
      val directory = File(output)
      directory.mkdirs()
      File(directory, FILE_NAME).writeText(generated, Charsets.UTF_8)
      return
    }
    val relative = "test/fixtures/android-contract/$FILE_NAME"
    val committed =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, relative) }
        .firstOrNull { it.isFile }
    val regenerate =
      "Regenerate: cd android && AUTOMOBILE_FIXTURE_OUT_DIR=\$PWD/../test/fixtures/android-contract ./gradlew :protocol:test --tests '*ResponseContractFixtureTest*'"
    assertTrue(committed != null, "Could not locate $relative. $regenerate")
    assertEquals(committed.readText(Charsets.UTF_8), generated, regenerate)
  }

  private companion object {
    const val FILE_NAME = "android-responses.json"
  }
}
