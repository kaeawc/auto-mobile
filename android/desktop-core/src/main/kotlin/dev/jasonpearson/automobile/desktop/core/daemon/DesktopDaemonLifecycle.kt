package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal interface DaemonSocketChecker {
  fun exists(): Boolean
}

internal class FileDaemonSocketChecker(
  private val socketPath: String = DaemonSocketPaths.socketPath()
) : DaemonSocketChecker {
  override fun exists(): Boolean = File(socketPath).exists()
}

internal interface DaemonPidFileReader {
  fun read(): DaemonPidState?
}

internal data class DaemonPidState(
  val version: String?,
  val launchArguments: List<String> = emptyList(),
)

internal class JsonDaemonPidFileReader(
  private val pidFilePath: String = DaemonSocketPaths.pidFilePath(),
  private val json: Json = DaemonJson,
) : DaemonPidFileReader {
  override fun read(): DaemonPidState? {
    return try {
      val pidFile = File(pidFilePath)
      if (!pidFile.exists()) return null
      val pidData = json.parseToJsonElement(pidFile.readText()).jsonObject
      DaemonPidState(
        version =
          pidData["version"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() },
        launchArguments = pidData["options"]?.jsonObject?.toLaunchArguments().orEmpty(),
      )
    } catch (_: Exception) {
      null
    }
  }

  /**
   * Mirrors the daemon CLI's option parser for the stable PID-file options boundary. A closed list
   * avoids forwarding unknown JSON values into a process invocation while retaining every
   * behavior-affecting option that a running daemon has already accepted.
   */
  private fun JsonObject.toLaunchArguments(): List<String> = buildList {
    fun booleanOption(key: String, flag: String) {
      if (this@toLaunchArguments[key]?.jsonPrimitive?.booleanOrNull == true) add(flag)
    }
    fun valueOption(key: String, flag: String) {
      this@toLaunchArguments[key]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.takeIf { it.isNotEmpty() }
        ?.let { value -> addAll(listOf(flag, value)) }
    }

    valueOption("port", "--port")
    valueOption("host", "--host")
    booleanOption("debug", "--debug")
    booleanOption("debugPerf", "--debug-perf")
    valueOption("planExecutionLockScope", "--plan-execution-lock-scope")
    valueOption("videoQualityPreset", "--video-quality")
    valueOption("videoTargetBitrateKbps", "--video-target-bitrate-kbps")
    valueOption("videoMaxThroughputMbps", "--video-max-throughput-mbps")
    valueOption("videoFps", "--video-fps")
    valueOption("videoFormat", "--video-format")
    valueOption("videoMaxArchiveSizeMb", "--video-archive-size-mb")
    valueOption("toolOutputsDir", "--tool-outputs-dir")
    booleanOption("networkMockable", "--network-mockable")
    booleanOption("embeddedSdk", "--embedded-sdk")
    booleanOption("dismissKeyboardAfterInput", "--dismiss-keyboard-after-input")
    val eventAllMarkers = this@toLaunchArguments["eventAllMarkers"] as? JsonArray
    val markerValues = eventAllMarkers?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
    if (markerValues.isNotEmpty()) {
      addAll(listOf("--event-all-markers", markerValues.joinToString(",")))
    } else {
      booleanOption("eventAllMarkersCliOverride", "--event-all-markers=")
    }
    booleanOption("noUiPerfMode", "--no-ui-perf-mode")
    booleanOption("memPerfAudit", "--mem-perf-audit")
    booleanOption("accessibilityAudit", "--accessibility-audit")
    valueOption("accessibilityLevel", "--accessibility-level")
    valueOption("accessibilityFailureMode", "--accessibility-failure-mode")
    valueOption("accessibilityMinSeverity", "--accessibility-min-severity")
    booleanOption("accessibilityUseBaseline", "--accessibility-use-baseline")
    booleanOption("predictiveUi", "--predictive-ui")
    booleanOption("rawElementSearch", "--raw-element-search")
    booleanOption("skipCtrlProxyDownload", "--skip-ctrl-proxy-download")
    booleanOption("mcpRecording", "--mcp-recording")
    booleanOption("noNavigationScreenshots", "--no-navigation-screenshots")
    booleanOption("noWaitForPollingOverhead", "--no-waitfor-polling-overhead")
    booleanOption("noA11yIncludeNotImportantViews", "--no-include-not-important-views")
    booleanOption("noA11yReportViewIds", "--no-report-view-ids")
    booleanOption("noA11yRetrieveInteractiveWindows", "--no-retrieve-interactive-windows")
    booleanOption("noOcclusion", "--no-occlusion")
    booleanOption("safeAreaWarnings", "--safe-area-warnings")
    booleanOption("observeResultDropElements", "--observe-result-drop-elements")
    booleanOption("observeResultCompact", "--observe-result-compact")
    booleanOption("observeResultProjectSkeleton", "--observe-result-project-skeleton")
    booleanOption("toolResultsNoStructuredContent", "--tool-results-no-structured-content")
    booleanOption("actionsDiffObserve", "--actions-diff-observe")
    booleanOption("actionsNoObserve", "--actions-no-observe")
    booleanOption("toolResultsCompactJson", "--tool-results-compact-json")
    booleanOption("observeFocusScope", "--observe-focus-scope")
    booleanOption("observeOverview", "--observe-overview")
    booleanOption("observeRegion", "--observe-region")
  }
}

internal data class DaemonCommandResult(
  val exitCode: Int,
  val output: String,
  val timedOut: Boolean = false,
)

internal interface DaemonCommandExecutor {
  fun execute(command: List<String>): DaemonCommandResult
}

internal object SystemDaemonCommandExecutor : DaemonCommandExecutor {
  override fun execute(command: List<String>): DaemonCommandResult {
    val process = ProcessBuilder(command).redirectErrorStream(true).start()
    val output = StringBuffer()
    val outputDrainer = Thread {
      process.inputStream.bufferedReader().useLines { lines ->
        lines.forEach { line -> output.appendLine(line) }
      }
    }
      .apply {
        isDaemon = true
        start()
      }
    if (!process.waitFor(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      process.destroy()
      if (!process.waitFor(TERMINATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
        process.destroyForcibly()
        process.waitFor(TERMINATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      }
      return DaemonCommandResult(
        exitCode = TIMEOUT_EXIT_CODE,
        output = drainOutput(process, outputDrainer, output),
        timedOut = true,
      )
    }
    return DaemonCommandResult(
      exitCode = process.exitValue(),
      output = drainOutput(process, outputDrainer, output),
    )
  }

  private fun drainOutput(
    process: Process,
    outputDrainer: Thread,
    output: StringBuffer,
  ): String {
    outputDrainer.join(TERMINATION_TIMEOUT_SECONDS * 1_000)
    if (outputDrainer.isAlive) {
      process.inputStream.close()
      outputDrainer.join(TERMINATION_TIMEOUT_SECONDS * 1_000)
    }
    return output.toString()
  }

  private const val COMMAND_TIMEOUT_SECONDS = 60L
  private const val TERMINATION_TIMEOUT_SECONDS = 5L
  private const val TIMEOUT_EXIT_CODE = -1
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
  data class Ready(val restarted: Boolean) : DaemonLifecycleResult

  data class Failure(val message: String) : DaemonLifecycleResult
}

internal interface DaemonLifecycleEnsurer {
  fun ensureVersionMatchedDaemon(): DaemonLifecycleResult
}

/**
 * Ensures the desktop only connects to a daemon that reports the same release version as the
 * desktop jar. The socket protocol gate remains the final authority; this lifecycle makes the UI
 * restart a skewed shared daemon before that gate rejects every ordinary request.
 */
internal class DesktopDaemonLifecycle(
  private val expectedVersionProvider: () -> String? = DaemonSocketPaths::resolveClientVersion,
  private val socketChecker: DaemonSocketChecker = FileDaemonSocketChecker(),
  private val pidFileReader: DaemonPidFileReader = JsonDaemonPidFileReader(),
  private val commandExecutor: DaemonCommandExecutor = SystemDaemonCommandExecutor,
  private val timer: DaemonRetryTimer = SystemDaemonRetryTimer,
  private val verificationAttempts: Int = DEFAULT_VERIFICATION_ATTEMPTS,
) : DaemonLifecycleEnsurer {
  override fun ensureVersionMatchedDaemon(): DaemonLifecycleResult =
    synchronized(lifecycleLock) {
      val expectedVersion =
        expectedVersionProvider()
          ?: return DaemonLifecycleResult.Failure(
            "Cannot verify the AutoMobile daemon version because this desktop build has no version. " +
              "Rebuild or reinstall the desktop application, then try again."
          )
      val currentDaemon = pidFileReader.read()
      val currentVersion = currentDaemon?.version
      val daemonAvailable = socketChecker.exists()
      if (daemonAvailable && versionsMatch(currentVersion, expectedVersion)) {
        return DaemonLifecycleResult.Ready(restarted = false)
      }

      if (declaresFullVersion(expectedVersion)) {
        return DaemonLifecycleResult.Failure(
          "AutoMobile desktop source build $expectedVersion cannot start a matching published daemon. " +
            "Start the daemon from the same checkout, then try again."
        )
      }

      val action = if (daemonAvailable) "restart" else "start"
      val command =
        packageDaemonCommand(expectedVersion, action, currentDaemon?.launchArguments.orEmpty())
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
        if (commandResult.timedOut) {
          return DaemonLifecycleResult.Failure(
            "Timed out while trying to $action AutoMobile $expectedVersion. " +
              "Check the daemon logs and retry."
          )
        }
        val detail =
          commandResult.output.trim().takeIf { it.isNotEmpty() }
            ?: "Install @kaeawc/auto-mobile@$expectedVersion and try again."
        return DaemonLifecycleResult.Failure(
          "Could not $action AutoMobile $expectedVersion (exit code ${commandResult.exitCode}). $detail"
        )
      }

      var actualVersion: String? = null
      repeat(verificationAttempts.coerceAtLeast(1)) { attempt ->
        actualVersion = pidFileReader.read()?.version
        if (socketChecker.exists() && versionsMatch(actualVersion, expectedVersion)) {
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

  private fun packageDaemonCommand(
    version: String,
    action: String,
    existingOptions: List<String>,
  ): List<String> =
    listOf(
      npxExecutable(System.getProperty("os.name", "")),
      "-y",
      "@kaeawc/auto-mobile@${DaemonSocketPaths.releaseVersion(version)}",
      "--daemon",
      action,
    ) + existingOptions

  private fun versionsMatch(
    actualVersion: String?,
    expectedVersion: String,
  ): Boolean {
    val actual = actualVersion?.trim().orEmpty()
    val expected = expectedVersion.trim()
    if (declaresFullVersion(expected)) {
      return actual.isNotEmpty() && actual == expected
    }
    val actualRelease = DaemonSocketPaths.releaseVersion(actual)
    val expectedRelease = DaemonSocketPaths.releaseVersion(expected)
    return actualRelease.isNotEmpty() && actualRelease == expectedRelease
  }

  private fun declaresFullVersion(version: String): Boolean =
    DaemonSocketPaths.releaseVersion(version) != version

  internal fun npxExecutable(osName: String): String =
    if (osName.lowercase().contains("win")) "npx.cmd" else "npx"

  private companion object {
    val lifecycleLock = Any()
    const val DEFAULT_VERIFICATION_ATTEMPTS = 20
    const val VERIFICATION_RETRY_DELAY_MS = 100L
  }
}
