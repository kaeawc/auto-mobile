package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.Test

/**
 * Pins the typed encoding of frames the CtrlProxy service used to hand-build, to the exact JSON
 * shape the hand-built code produced (#11877): absent optionals are omitted (not `null`), and
 * `perfTiming` is an embedded object.
 */
class TypedResultWireTest {
  private val json = Json {
    classDiscriminator = "type"
    encodeDefaults = true
  }

  private fun parsed(text: String): JsonElement = json.parseToJsonElement(text)

  private fun encode(response: WebSocketResponse): JsonElement =
    parsed(json.encodeToString<WebSocketResponse>(response))

  @Test
  fun `action result matches the hand-built frame with and without optionals`() {
    assertEquals(
      parsed(
        """{"type":"action_result","timestamp":5,"action":"click","success":true,"totalTimeMs":7}""",
      ),
      encode(ActionResult(timestamp = 5, success = true, action = "click", totalTimeMs = 7)),
    )
    assertEquals(
      parsed(
        """{"type":"action_result","timestamp":5,"requestId":"r","action":"focus","success":false,"totalTimeMs":7,"error":"boom","alreadySatisfied":true,"perfTiming":{"total":50,"steps":[1,2]}}""",
      ),
      encode(
        ActionResult(
          timestamp = 5,
          requestId = "r",
          success = false,
          action = "focus",
          totalTimeMs = 7,
          error = "boom",
          perfTiming = """{"total":50,"steps":[1,2]}""",
          alreadySatisfied = true,
        ),
      ),
    )
  }

  @Test
  fun `permission result matches the hand-built frame`() {
    assertEquals(
      parsed(
        """{"type":"permission_result","timestamp":9,"requestId":"p","success":true,"totalTimeMs":3,"permission":"android.permission.CAMERA","granted":false,"requestLaunched":true,"canRequest":true,"requiresSettings":false}""",
      ),
      encode(
        PermissionResult(
          timestamp = 9,
          requestId = "p",
          success = true,
          permission = "android.permission.CAMERA",
          granted = false,
          requestLaunched = true,
          canRequest = true,
          requiresSettings = false,
          totalTimeMs = 3,
        ),
      ),
    )
    assertEquals(
      parsed(
        """{"type":"permission_result","timestamp":9,"success":false,"totalTimeMs":3,"permission":"x","granted":false,"requestLaunched":false,"canRequest":false,"requiresSettings":true,"instructions":"open settings","adbCommand":"adb shell pm grant","error":"denied"}""",
      ),
      encode(
        PermissionResult(
          timestamp = 9,
          success = false,
          permission = "x",
          granted = false,
          requiresSettings = true,
          instructions = "open settings",
          adbCommand = "adb shell pm grant",
          totalTimeMs = 3,
          error = "denied",
        ),
      ),
    )
  }

  @Test
  fun `set keyboard profile result matches the hand-built frame`() {
    assertEquals(
      parsed(
        """{"type":"set_keyboard_profile_result","timestamp":1,"requestId":"k","success":true,"activeProfileId":"a","previousProfileId":"b"}""",
      ),
      encode(
        SetKeyboardProfileResult(
          timestamp = 1,
          requestId = "k",
          success = true,
          activeProfileId = "a",
          previousProfileId = "b",
        ),
      ),
    )
    assertEquals(
      parsed(
        """{"type":"set_keyboard_profile_result","timestamp":1,"success":false,"error":"nope"}""",
      ),
      encode(SetKeyboardProfileResult(timestamp = 1, success = false, error = "nope")),
    )
  }

  @Test
  fun `perf timing text embeds as an object and decodes back to compact JSON text`() {
    val frame =
      ActionResult(timestamp = 1, success = true, totalTimeMs = 1, perfTiming = """{"a":1}""")
    val text = json.encodeToString<WebSocketResponse>(frame)
    assertEquals(true, text.contains(""""perfTiming":{"a":1}"""), text)
    assertEquals(frame, json.decodeFromString<WebSocketResponse>(text))
  }

  @Test
  fun `perf timing that is not JSON stays a quoted string`() {
    val frame =
      ActionResult(timestamp = 1, success = true, totalTimeMs = 1, perfTiming = "not json {")
    val text = json.encodeToString<WebSocketResponse>(frame)
    assertEquals(true, text.contains(""""perfTiming":"not json {""""), text)
    assertEquals(frame, json.decodeFromString<WebSocketResponse>(text))
  }
}
