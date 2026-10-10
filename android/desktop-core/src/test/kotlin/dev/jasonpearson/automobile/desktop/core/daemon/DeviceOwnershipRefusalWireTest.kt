package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.serializer

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

  /** Every captured typed refusal, decoded through the tools/call error path. */
  private fun decoded(case: RefusalWireFixtures.Case): McpToolErrorException =
    assertFailsWith<McpToolErrorException>(case.name) {
      decodeToolResponse(DaemonJson, case.result, serializer<SetActiveDeviceResult>())
    }

  @Test
  fun `every captured refusal keeps its code, retryable, retryAfterMs and nextAction`() {
    val cases = RefusalWireFixtures.all()
    assertTrue(cases.size >= 50, "expected the full refusal-wire corpus, found ${cases.size}")
    cases.forEach { case ->
      val error = decoded(case)
      assertEquals(case.code, error.code, "${case.name}: code")
      // Rows without a wire `retryable` (managed-slot failures carry it only in a nested
      // acquisitionFailure) expect false.
      assertEquals(case.retryable ?: false, error.retryable ?: false, "${case.name}: retryable")
      assertEquals(case.retryAfterMs, error.retryAfterMs, "${case.name}: retryAfterMs")
      assertEquals(
        case.acquireNewSession,
        error.nextAction == NEXT_ACTION_ACQUIRE_NEW_SESSION,
        "${case.name}: nextAction",
      )
      assertEquals(
        case.acquireNewSession,
        error.isSessionTerminalRefusal(),
        "${case.name}: terminal",
      )
    }
  }

  @Test
  fun `a refusal surfaces its message field, not the raw JSON payload`() {
    RefusalWireFixtures.all().forEach { case ->
      val expected = case.message ?: return@forEach
      assertEquals(expected, decoded(case).message, "${case.name}: message")
    }
  }

  /** Answers every request with an input failure frame carrying [frame]'s fields. */
  private fun tapAnswering(frame: String): InputActionResult =
    McpDaemonClient(
        DaemonRequestTransport { request ->
          DaemonJson.decodeFromString<DaemonResponse>(
            """{"id":"${request.id}","type":"mcp_response","success":false,$frame}""",
          )
        },
        sessionUuid = desktopSession,
      )
      .inputTap(x = 1.0, y = 2.0, platform = "android", deviceId = "emulator-5554")

  @Test
  fun `a suspect-session input frame is retryable and keeps its remaining reservation`() {
    val result =
      tapAnswering(
        """"error":"Session is being restored; retry now","code":"daemon_session_suspect",""" +
          """"retryable":true,"details":{"deviceId":"emulator-5554","sessionUuid":"s1",""" +
          """"remainingMs":8000}""",
      )

    assertFalse(result.success)
    assertTrue(result.isSessionSuspect)
    assertFalse(result.isSessionOwnershipLost)
    assertEquals(true, result.retryable)
    assertEquals(8000L, result.retryAfterMs)
    assertEquals("Session is being restored; retry now", result.error)
  }

  @Test
  fun `an ownership-lost input frame is terminal for the session`() {
    val result =
      tapAnswering(
        """"error":"Session s1 no longer owns emulator-5554","code":"session_ownership_lost",""" +
          """"retryable":false,"details":{"deviceId":"emulator-5554","boundSessionUuid":"s2",""" +
          """"sessionUuid":"s1","reason":"heartbeat_timeout"}""",
      )

    assertFalse(result.success)
    assertTrue(result.isSessionOwnershipLost)
    assertFalse(result.isSessionSuspect)
    assertEquals(false, result.retryable)
    assertEquals(null, result.retryAfterMs)
  }

  @Test
  fun `a device-held input frame keeps retryable false and is neither suspect nor lost`() {
    val result =
      clientAnswering("tap-refused")
        .inputTap(x = 540.0, y = 1200.0, platform = "android", deviceId = "emulator-5554")

    assertEquals(false, result.retryable)
    assertFalse(result.isSessionSuspect)
    assertFalse(result.isSessionOwnershipLost)
  }
}
