package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal interface DaemonSocketChecker {
  fun exists(): Boolean
}

internal class FileDaemonSocketChecker(
  private val socketPath: String = DaemonSocketPaths.socketPath(),
) : DaemonSocketChecker {
  override fun exists(): Boolean = File(socketPath).exists()
}

internal interface DaemonPidFileReader {
  fun readVersion(): String?
}

internal class JsonDaemonPidFileReader(
  private val pidFilePath: String = DaemonSocketPaths.pidFilePath(),
  private val json: Json = DaemonJson,
) : DaemonPidFileReader {
  override fun readVersion(): String? {
    return try {
      val pidFile = File(pidFilePath)
      if (!pidFile.exists()) return null
      json
        .parseToJsonElement(pidFile.readText())
        .jsonObject["version"]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
      null
    }
  }
}

internal data class DaemonCommandResult(
  val exitCode: Int,
  val output: String,
)

internal interface DaemonCommandExecutor {
  fun execute(command: List<String>): DaemonCommandResult
}

internal object SystemDaemonCommandExecutor : DaemonCommandExecutor {
  override fun execute(command: List<String>): DaemonCommandResult {
    val process = ProcessBuilder(command).redirectErrorStream(true).start()
    val output = process.inputStream.bufferedReader().use { it.readText() }
    return DaemonCommandResult(exitCode = process.waitFor(), output = output)
  }
}

internal interface DaemonRetryTimer {
  fun sleep(milliseconds: Long)
}

internal object SystemDaemonRetryTimer : DaemonRetryTimer {
  override fun sleep(milliseconds: Long) {
    Thread.sleep(milliseconds)
  }
}

internal sealed interface DaemonLifecycleResult {
  data class Ready(
    val restarted: Boolean,
  ) : DaemonLifecycleResult

  data class Failure(
    val message: String,
  ) : DaemonLifecycleResult
}

/**
 * Ensures the desktop only connects to a daemon that reports the same release version as the
 * desktop jar. The socket protocol gate remains the final authority; this lifecycle makes the
 * UI restart a skewed shared daemon before that gate rejects every ordinary request.
 */
internal class DesktopDaemonLifecycle(
  private val expectedVersionProvider: () -> String? = DaemonSocketPaths::resolveClientVersion,
  private val socketChecker: DaemonSocketChecker = FileDaemonSocketChecker(),
  private val pidFileReader: DaemonPidFileReader = JsonDaemonPidFileReader(),
  private val commandExecutor: DaemonCommandExecutor = SystemDaemonCommandExecutor,
  private val timer: DaemonRetryTimer = SystemDaemonRetryTimer,
  private val verificationAttempts: Int = DEFAULT_VERIFICATION_ATTEMPTS,
) {
  fun ensureVersionMatchedDaemon(): DaemonLifecycleResult {
    val expectedVersion = expectedVersionProvider()
      ?: return DaemonLifecycleResult.Failure(
        "Cannot verify the AutoMobile daemon version because this desktop build has no version. " +
          "Rebuild or reinstall the desktop application, then try again."
      )
    val currentVersion = pidFileReader.readVersion()
    if (versionsMatch(currentVersion, expectedVersion)) {
      return DaemonLifecycleResult.Ready(restarted = false)
    }

    val action = if (socketChecker.exists()) "restart" else "start"
    val command = packageDaemonCommand(expectedVersion, action)
    val commandResult =
      try {
        commandExecutor.execute(command)
      } catch (error: Exception) {
        return DaemonLifecycleResult.Failure(
          "Could not $action AutoMobile $expectedVersion: ${error.message ?: error.javaClass.simpleName}. " +
            "Install Node.js with npx available, then try again."
        )
    }
    if (commandResult.exitCode != 0) {
      val detail =
        commandResult.output.trim().takeIf { it.isNotEmpty() }
          ?: "Install @kaeawc/auto-mobile@$expectedVersion and try again."
      return DaemonLifecycleResult.Failure(
        "Could not $action AutoMobile $expectedVersion (exit code ${commandResult.exitCode}). $detail"
      )
    }

    var actualVersion: String? = null
    repeat(verificationAttempts.coerceAtLeast(1)) { attempt ->
      actualVersion = pidFileReader.readVersion()
      if (versionsMatch(actualVersion, expectedVersion)) {
        return DaemonLifecycleResult.Ready(restarted = true)
      }
      if (attempt + 1 < verificationAttempts.coerceAtLeast(1)) {
        timer.sleep(VERIFICATION_RETRY_DELAY_MS)
      }
    }
    return DaemonLifecycleResult.Failure(
      "AutoMobile daemon version mismatch: desktop requires $expectedVersion, but the daemon " +
        "reports ${actualVersion ?: "no version"}. Stop the existing daemon and retry so " +
        "@kaeawc/auto-mobile@$expectedVersion can start."
    )
  }

  private fun packageDaemonCommand(version: String, action: String): List<String> =
    listOf(
      "npx",
      "-y",
      "@kaeawc/auto-mobile@${DaemonSocketPaths.releaseVersion(version)}",
      "--daemon",
      action,
    )

  private fun versionsMatch(
    actualVersion: String?,
    expectedVersion: String,
  ): Boolean {
    val actualRelease = DaemonSocketPaths.releaseVersion(actualVersion?.trim().orEmpty())
    val expectedRelease = DaemonSocketPaths.releaseVersion(expectedVersion.trim())
    return actualRelease.isNotEmpty() && actualRelease == expectedRelease
  }

  private companion object {
    const val DEFAULT_VERIFICATION_ATTEMPTS = 20
    const val VERIFICATION_RETRY_DELAY_MS = 100L
  }
}
