package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * #10960: a start the daemon refuses as `device_cleanup_in_progress` keeps its retry hint on the
 * result so the picker can wait instead of failing. The payload mirrors the refusal
 * `shapeToolCallError` renders for `DeviceCleanupInProgressError` (`test/cli/deviceOwnershipRefusal.test.ts`).
 */
class McpDaemonClientStartDeviceCleanupTest {
  private fun start(payload: String): StartDeviceResult {
    val envelope =
      buildJsonObject {
          put("isError", JsonPrimitive(true))
          put(
            "content",
            buildJsonArray {
              add(
                buildJsonObject {
                  put("type", "text")
                  put("text", payload)
                },
              )
            },
          )
        }
        .toString()
    return McpDaemonClient(
        requestTransport =
          DaemonRequestTransport { request ->
            DaemonResponse(
              id = request.id,
              type = "mcp_response",
              success = true,
              result = DaemonJson.parseToJsonElement(envelope),
            )
          },
        sessionUuid = "00000000-0000-4000-8000-000000000001",
      )
      .startDevice(name = "Pixel", platform = "android", deviceId = "emulator-5554")
  }

  @Test
  fun `a cleanup refusal keeps its retryAfterMs`() {
    val result =
      start(
        buildJsonObject {
            put("success", false)
            put("error", "Device 'emulator-5554' is still completing the previous session's cleanup")
            put("code", "device_cleanup_in_progress")
            put("deviceId", "emulator-5554")
            put("retryable", true)
            put("retryAfterMs", 4_000)
          }
          .toString(),
      )
    assertFalse(result.success)
    assertEquals(4_000L, result.cleanupRetryAfterMs)
  }

  @Test
  fun `a cleanup refusal without a hint falls back to one second`() {
    val result =
      start(
        buildJsonObject {
            put("success", false)
            put("error", "cleanup")
            put("code", "device_cleanup_in_progress")
          }
          .toString(),
      )
    assertEquals(1_000L, result.cleanupRetryAfterMs)
  }

  @Test
  fun `any other failure carries no cleanup hint`() {
    val result =
      start(
        buildJsonObject {
            put("success", false)
            put("error", "held")
            put("code", "device_owned_by_other_session")
            put("retryAfterMs", 4_000)
          }
          .toString(),
      )
    assertFalse(result.success)
    assertNull(result.cleanupRetryAfterMs)
  }
}
