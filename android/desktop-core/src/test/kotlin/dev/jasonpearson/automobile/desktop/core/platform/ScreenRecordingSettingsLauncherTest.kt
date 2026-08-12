package dev.jasonpearson.automobile.desktop.core.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ScreenRecordingSettingsLauncherTest {
  @Test
  fun `opens the macOS Screen Recording privacy pane`() {
    var command: List<String>? = null
    val launcher =
      MacScreenRecordingSettingsLauncher(
        isMacOs = { true },
        startProcess = { command = it },
      )

    val result = launcher.openScreenRecording()

    assertTrue(result.isSuccess)
    assertEquals(
      listOf(
        "open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ),
      command,
    )
  }

  @Test
  fun `reports that Screen Recording settings are unavailable off macOS`() {
    val launcher = MacScreenRecordingSettingsLauncher(isMacOs = { false })

    val result = launcher.openScreenRecording()

    assertTrue(result.isFailure)
    assertEquals(
      "Screen Recording settings are only available on macOS.",
      result.exceptionOrNull()?.message,
    )
  }
}
