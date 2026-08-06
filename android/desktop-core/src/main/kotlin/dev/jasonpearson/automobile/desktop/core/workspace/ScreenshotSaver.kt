package dev.jasonpearson.automobile.desktop.core.workspace

import java.io.File

/**
 * Writes a captured device-screen PNG to disk for the Screenshot control (#4694 AC3). The pane
 * already shows the device live (the workspace stream mirror), so Screenshot is a capture-to-file,
 * not an on-screen preview: it persists the current frame and reports where it landed.
 *
 * A `fun interface` so a test can supply a lambda that records the bytes without touching the disk;
 * the real implementation is [RealScreenshotSaver].
 */
fun interface ScreenshotSaver {
  /** Persist [pngBytes] captured from [deviceName]'s screen; returns the saved file's path. */
  fun save(deviceName: String, pngBytes: ByteArray): String
}

/**
 * Saves screenshots as `<sanitized-device-name>-<timestamp>.png` under [directory] (by default
 * `~/.auto-mobile/screenshots`). [clock] is injectable so the filename is deterministic in tests.
 */
class RealScreenshotSaver(
  private val directory: File = File(System.getProperty("user.home"), ".auto-mobile/screenshots"),
  private val clock: () -> Long = System::currentTimeMillis,
) : ScreenshotSaver {
  override fun save(deviceName: String, pngBytes: ByteArray): String {
    directory.mkdirs()
    val safeName = deviceName.replace(UNSAFE_FILENAME_CHARS, "_").ifBlank { "device" }
    val file = File(directory, "$safeName-${clock()}.png")
    file.writeBytes(pngBytes)
    return file.absolutePath
  }

  private companion object {
    val UNSAFE_FILENAME_CHARS = Regex("[^A-Za-z0-9._-]")
  }
}
