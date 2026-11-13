package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceOwnedGiveUpMessageTest {
  @Test
  fun `a device another session holds names the release command an agent can run`() {
    val message =
      DeviceWaitPolicy.deviceOwnedGiveUpMessage(
        ParsedToolResult(
          success = false,
          errorMessage = "held",
          code = DeviceWaitPolicy.DEVICE_OWNED_BY_OTHER_SESSION_CODE,
          daemonMessage = "Device 'emulator-5558' is already assigned to another session.",
        ),
        30_000L,
      )

    assertTrue(message, message.contains("waited 30000ms"))
    assertTrue(message, message.contains("auto-mobile --daemon release-session <sessionUuid>"))
    assertTrue(message, message.contains("auto-mobile --daemon active-sessions"))
    assertTrue(message, message.contains("device stays booted"))
  }

  @Test
  fun `a device another daemon claims does not suggest releasing a session`() {
    val message =
      DeviceWaitPolicy.deviceOwnedGiveUpMessage(
        ParsedToolResult(
          success = false,
          errorMessage = "claimed",
          code = DeviceWaitPolicy.DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        ),
        30_000L,
      )

    assertFalse(message, message.contains("release-session"))
  }
}
