package dev.jasonpearson.automobile.junit

import java.util.concurrent.TimeUnit

internal class DaemonUserIdResolver(
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
      // Command failure safely falls back to the cached user name.
      null
    }
  },
) {
  val userId: String by
    lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
      if (osName().lowercase().contains("win")) {
        userName()
      } else {
        // Keep id -u to match DaemonSocketClient's PID path; JVM UID APIs may differ.
        runCommand(listOf("id", "-u"))?.trim()?.takeIf { it.isNotEmpty() } ?: userName()
      }
    }

  fun pidPath(): String = "/tmp/auto-mobile-daemon-$userId.pid"
}
