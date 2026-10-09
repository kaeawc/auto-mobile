package dev.jasonpearson.automobile.junit

import java.util.concurrent.TimeUnit

internal class DaemonUserIdResolver(
  private val envProvider: (String) -> String? = System::getenv,
  private val osName: () -> String = { System.getProperty("os.name").orEmpty() },
  private val userName: () -> String = {
    System.getProperty("user.name", "default").ifBlank { "default" }
  },
  private val runCommand: (List<String>) -> String? = { command ->
    try {
      val process = ProcessBuilder(command).start()
      if (!process.waitFor(2, TimeUnit.SECONDS)) {
        process.destroy()
        null
      } else if (process.exitValue() != 0) {
        null
      } else {
        process.inputStream.bufferedReader().use { it.readText().trim() }
      }
    } catch (_: Exception) {
      // Safe to swallow: this call uses an uncached user name fallback; a later call retries.
      null
    }
  },
) {
  private val resolutionLock = Any()
  private var cachedUserId: String? = null

  val userId: String
    get() =
      synchronized(resolutionLock) {
        cachedUserId?.let {
          return@synchronized it
        }
        if (osName().lowercase().contains("win")) {
          userName().also { cachedUserId = it }
        } else {
          // Keep id -u to match DaemonSocketClient's PID path; JVM UID APIs may differ.
          runCommand(listOf("id", "-u"))
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.also { cachedUserId = it } ?: userName()
        }
      }

  /** Same resolution as `DaemonSocketPaths.pidFilePath()` (overrides, aux-dir suffix). */
  fun pidPath(): String = DaemonStatePaths.resolve(DaemonStateFile.PID, { userId }, envProvider)
}
