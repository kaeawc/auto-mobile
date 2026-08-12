package dev.jasonpearson.automobile.desktop.core.platform

private const val SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"

/** Opens the macOS privacy pane needed to approve iOS Simulator observation. */
fun interface ScreenRecordingSettingsLauncher {
  fun openScreenRecording(): Result<Unit>
}

/**
 * Production macOS settings launcher. [isMacOs] and [startProcess] are injected so the platform
 * behavior remains deterministic in unit tests.
 */
class MacScreenRecordingSettingsLauncher(
  private val isMacOs: () -> Boolean = {
    System.getProperty("os.name", "").contains("Mac", ignoreCase = true)
  },
  private val startProcess: (List<String>) -> Unit = { command ->
    ProcessBuilder(command).start()
  },
) : ScreenRecordingSettingsLauncher {
  override fun openScreenRecording(): Result<Unit> {
    if (!isMacOs()) {
      return Result.failure(
        IllegalStateException("Screen Recording settings are only available on macOS.")
      )
    }
    return runCatching {
      startProcess(listOf("open", SCREEN_RECORDING_SETTINGS_URL))
    }
  }
}
