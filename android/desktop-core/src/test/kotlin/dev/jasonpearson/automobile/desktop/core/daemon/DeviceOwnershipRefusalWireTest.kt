package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The client keeps the daemon's typed refusal code (#10743, #10783) from the captured
 * `held-device-input-refused` fixture: on an `input/tap` socket response and in a refused tool
 * call's error payload. Callers match that code to show the held-elsewhere notice.
 */
class DeviceOwnershipRefusalWireTest {
  private val fixture = DesktopWireFixture.load("held-device-input-refused")
  private val desktopSession = fixture.sessions.getValue("desktop-1")

  /** Answers each request with the recorded exchange [label], after checking it is that frame. */
  private fun clientAnswering(label: String): McpDaemonClient {
    val exchange = fixture.exchange(label)
    return McpDaemonClient(
      DaemonRequestTransport { request ->
        check(exchange.matches(request)) {
          "client sent ${request.method} ${request.params}, fixture recorded ${exchange.params}"
        }
        exchange.response(request.id)
      },
      sessionUuid = desktopSession,
    )
  }

  @Test
  fun `a refused tap keeps the daemon's code`() {
    val result =
      clientAnswering("tap-refused")
        .inputTap(x = 540.0, y = 1200.0, platform = "android", deviceId = "emulator-5554")

    assertFalse(result.success)
    assertEquals(DEVICE_OWNED_BY_OTHER_SESSION_CODE, result.code)
    assertTrue(result.isDeviceOwnedRefusal)
  }

  @Test
  fun `a refused device control throws with the payload's code and device`() {
    val error =
      assertFailsWith<McpToolErrorException> {
        clientAnswering("rotate-refused")
          .callToolChecked(
            "rotate",
            buildJsonObject {
              put("orientation", JsonPrimitive("landscape"))
              put("platform", JsonPrimitive("android"))
              put("deviceId", JsonPrimitive("emulator-5554"))
            },
          )
      }

    assertEquals(DEVICE_OWNED_BY_OTHER_SESSION_CODE, error.code)
    assertEquals("emulator-5554", error.deviceId)
    assertTrue(error.isDeviceOwnedRefusal())
    assertTrue(error.message.orEmpty().startsWith("rotate refused"))
  }

  @Test
  fun `a refused kill keeps the code on its result`() {
    // killDevice refusals use the same tool error payload as any device-aware tool (#10785).
    val result = decodeKillDeviceResponse(DaemonJson, fixture.exchange("rotate-refused").result)

    assertFalse(result.success)
    assertEquals(DEVICE_OWNED_BY_OTHER_SESSION_CODE, result.code)
  }
}
