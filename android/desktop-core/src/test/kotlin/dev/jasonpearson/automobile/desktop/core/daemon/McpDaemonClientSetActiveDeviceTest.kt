package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * #10682: only the daemon's ownership refusal and a terminal session are refusals the desktop
 * session loop acts on. The shapes mirror `src/server/setActiveDevice.ts` errors rendered by
 * `shapeToolCallError` (`Error: <message>`) and the `TerminalSessionError` branch of
 * `src/server/index.ts` (`sessionOwnershipLostPayload`).
 */
class McpDaemonClientSetActiveDeviceTest {
  @Test
  fun `an ownership refusal is held by another session`() {
    val result =
      bind(errorText("Error: Device 'emulator-5554' is already assigned to session abc-123"))
    assertFalse(result.success)
    assertEquals(SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION, result.refusal)
  }

  @Test
  fun `the pool's bind conflict with a trailing period is held by another session`() {
    val result =
      bind(errorText("Error: Device 'emulator-5554' is already assigned to session abc-123."))
    assertEquals(SetActiveDeviceRefusal.HELD_BY_ANOTHER_SESSION, result.refusal)
  }

  @Test
  fun `session ownership lost is a released session`() {
    val payload = buildJsonObject {
      put(
        "error",
        buildJsonObject {
          put("code", "session_ownership_lost")
          put("message", "Session s1 is terminal after idle-timeout and cannot be reused.")
        },
      )
    }
      .toString()
    assertEquals(SetActiveDeviceRefusal.SESSION_RELEASED, bind(errorText(payload)).refusal)
  }

  @Test
  fun `a wrapped terminal session message is a released session`() {
    val text =
      "Error: Failed to set active device: Session s1 was released and cannot be reused. " +
        "Acquire a new device with getAndroid or getApple."
    assertEquals(SetActiveDeviceRefusal.SESSION_RELEASED, bind(errorText(text)).refusal)
  }

  @Test
  fun `unrelated daemon errors are not refusals`() {
    listOf(
        "Error: Device 'emulator-5554' not found in device pool",
        "Error: Device 'emulator-5554' cleanup is still in progress; retry shortly",
        "Error: Failed to set active device: CtrlProxy resume failed",
      )
      .forEach { text ->
        val result = bind(errorText(text))
        assertFalse(result.success, text)
        assertEquals(null, result.refusal, text)
      }
  }

  @Test
  fun `a successful bind carries no refusal`() {
    val result =
      bind(
        buildJsonObject {
          put(
            "content",
            buildJsonArray {
              add(
                buildJsonObject {
                  put("type", "text")
                  put("text", """{"message":"Active device set to 'emulator-5554'"}""")
                }
              )
            },
          )
        }
          .toString()
      )
    assertTrue(result.success)
    assertEquals(null, result.refusal)
  }

  private fun errorText(text: String): String = buildJsonObject {
    put("isError", JsonPrimitive(true))
    put(
      "content",
      buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", text)
          }
        )
      },
    )
  }
    .toString()

  private fun bind(result: String): SetActiveDeviceResult =
    McpDaemonClient(
        requestTransport =
          DaemonRequestTransport { request ->
            DaemonResponse(
              id = request.id,
              type = "mcp_response",
              success = true,
              result = DaemonJson.parseToJsonElement(result),
            )
          },
        sessionUuid = "00000000-0000-4000-8000-000000000001",
      )
      .setActiveDevice("emulator-5554", "android")
}
