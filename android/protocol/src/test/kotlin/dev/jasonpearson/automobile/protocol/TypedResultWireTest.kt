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

  @Test
  fun `clipboard ca cert device owner ime action and select all keep the hand-built field order`() {
    val ordered = orderedJson()
    fun text(response: WebSocketResponse) = ordered.encodeToString<WebSocketResponse>(response)
    assertEquals(
      """{"type":"clipboard_result","timestamp":1,"requestId":"r","action":"get","success":true,"totalTimeMs":2,"text":"t","perfTiming":{"a":1}}""",
      text(
        ClipboardResult(
          timestamp = 1,
          requestId = "r",
          action = "get",
          success = true,
          totalTimeMs = 2,
          text = "t",
          perfTiming = """{"a":1}""",
        ),
      ),
    )
    assertEquals(
      """{"type":"ca_cert_result","timestamp":1,"action":"install","success":false,"totalTimeMs":2,"alias":"a","error":"e"}""",
      text(
        CaCertResult(
          timestamp = 1,
          action = "install",
          success = false,
          totalTimeMs = 2,
          alias = "a",
          error = "e",
        ),
      ),
    )
    assertEquals(
      """{"type":"device_owner_status_result","timestamp":1,"success":true,"totalTimeMs":2,"packageName":"p","isDeviceOwner":true,"isAdminActive":false}""",
      text(
        DeviceOwnerStatusResult(
          timestamp = 1,
          success = true,
          totalTimeMs = 2,
          packageName = "p",
          isDeviceOwner = true,
          isAdminActive = false,
        ),
      ),
    )
    assertEquals(
      """{"type":"ime_action_result","timestamp":1,"approximated":true,"action":"next","success":true,"totalTimeMs":2}""",
      text(
        ImeActionResult(
          timestamp = 1,
          approximated = true,
          action = "next",
          success = true,
          totalTimeMs = 2,
        ),
      ),
    )
    assertEquals(
      """{"type":"select_all_result","timestamp":1,"success":true,"totalTimeMs":2}""",
      text(SelectAllResult(timestamp = 1, success = true, totalTimeMs = 2)),
    )
  }

  @Test
  fun `text, ime and event frames keep the hand-built field order`() {
    val ordered = orderedJson()
    fun text(response: WebSocketResponse) = ordered.encodeToString<WebSocketResponse>(response)
    assertEquals(
      """{"type":"commit_text_result","timestamp":1,"requestId":"r","success":false,"totalTimeMs":2,"partialApplication":true,"committedUnits":3,"insertedText":"t","editorConsumed":true,"trace":["a"],"error":"e","perfTiming":{"a":1}}""",
      text(
        CommitTextResult(
          timestamp = 1,
          requestId = "r",
          success = false,
          totalTimeMs = 2,
          partialApplication = true,
          committedUnits = 3,
          insertedText = "t",
          editorConsumed = true,
          trace = listOf("a"),
          error = "e",
          perfTiming = """{"a":1}""",
        ),
      ),
    )
    assertEquals(
      """{"type":"commit_text_result","timestamp":1,"success":true,"totalTimeMs":2}""",
      text(CommitTextResult(timestamp = 1, success = true, totalTimeMs = 2)),
    )
    assertEquals(
      """{"type":"insert_text_result","timestamp":1,"success":true,"totalTimeMs":2,"warning":"w","caretPlaced":false,"resultingTextLength":4,"partialApplication":true}""",
      text(
        InsertTextResult(
          timestamp = 1,
          success = true,
          totalTimeMs = 2,
          warning = "w",
          caretPlaced = false,
          resultingTextLength = 4,
          partialApplication = true,
        ),
      ),
    )
    assertEquals(
      """{"type":"cancel_ime_commit_result","timestamp":1,"success":true,"targetRequestId":"t","partialApplication":false}""",
      text(CancelImeCommitResult(timestamp = 1, targetRequestId = "t", partialApplication = false)),
    )
    assertEventFieldOrder(::text)
  }

  private fun orderedJson(): Json = Json {
    classDiscriminator = "type"
    encodeDefaults = true
    explicitNulls = false
  }

  private fun assertEventFieldOrder(text: (WebSocketResponse) -> String) {
    assertEquals(
      """{"type":"screenshot_error","timestamp":1,"requestId":"r","error":"e","displayId":2,"panelUniqueId":"p"}""",
      text(
        ScreenshotErrorResult(
          timestamp = 1,
          requestId = "r",
          error = "e",
          displayId = 2,
          panelUniqueId = "p",
        ),
      ),
    )
    assertEquals(
      """{"type":"display_transition","timestamp":1,"change":"rotation","displayId":0,"panelFingerprint":{"width":1,"height":2},"width":3,"rotation":1}""",
      text(
        DisplayTransitionEvent(
          timestamp = 1,
          change = "rotation",
          displayId = 0,
          panelFingerprint = DisplayPanelFingerprint(1, 2),
          width = 3,
          rotation = 1,
        ),
      ),
    )
    assertEquals(
      """{"type":"package_event","timestamp":1,"event":{"action":"added","packageName":"p","userId":10,"uid":5,"removedForAllUsers":true}}""",
      text(
        PackageEvent(
          timestamp = 1,
          event = PackageEventData("added", "p", 10, uid = 5, removedForAllUsers = true),
        ),
      ),
    )
    assertEquals(
      """{"type":"interaction_event","timestamp":1,"event":{"type":"tap","packageName":null}}""",
      text(InteractionEvent(timestamp = 1, event = """{"type":"tap","packageName":null}""")),
    )
  }
}
