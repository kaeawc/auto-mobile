package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.net.UnixDomainSocketAddress
import java.nio.channels.SocketChannel
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal interface DaemonSocketChecker {
  fun isReady(): Boolean
}

internal class FileDaemonSocketChecker(
  private val socketPath: String = DaemonSocketPaths.socketPath()
) : DaemonSocketChecker {
  override fun isReady(): Boolean {
    if (!File(socketPath).exists()) return false
    return try {
      SocketChannel.open(UnixDomainSocketAddress.of(socketPath)).use { true }
    } catch (_: Exception) {
      false
    }
  }
}

internal interface DaemonPidFileReader {
  fun read(): DaemonPidReadResult
}

internal data class DaemonPidState(
  val version: String?,
  val launchArguments: List<String> = emptyList(),
)

internal sealed interface DaemonPidReadResult {
  data object Absent : DaemonPidReadResult

  data object Unreadable : DaemonPidReadResult

  data class Present(val state: DaemonPidState) : DaemonPidReadResult
}

internal class JsonDaemonPidFileReader(
  private val pidFilePath: String = DaemonSocketPaths.pidFilePath(),
  private val json: Json = DaemonJson,
) : DaemonPidFileReader {
  override fun read(): DaemonPidReadResult {
    val pidFile = File(pidFilePath)
    if (!pidFile.exists()) return DaemonPidReadResult.Absent
    return try {
      val pidData = json.parseToJsonElement(pidFile.readText()).jsonObject
      DaemonPidReadResult.Present(
        DaemonPidState(
          version =
            pidData["version"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() },
          launchArguments = (pidData["options"] as? JsonObject)?.toLaunchArguments().orEmpty(),
        )
      )
    } catch (_: Exception) {
      DaemonPidReadResult.Unreadable
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
    val markerValues =
      eventAllMarkers
        ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
        .orEmpty()
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
  val cancelled: Boolean = false,
)

/** A resolved launch command plus the runner's own directory to publish onto the child `PATH`. */
internal data class DaemonLaunchCommand(
  val command: List<String>,
  val runnerDirectory: String?,
)

internal interface DaemonCommandExecutor {
  /**
   * [runnerDirectory], when non-null, is prepended to the child's `PATH`. `npx` is a
   * `#!/usr/bin/env node` script, so under a GUI-stripped `PATH` an absolute `npx` still exits 127
   * because the sibling `node` is undiscoverable; publishing the runner's own directory fixes that
   * (and is harmless for the self-contained `bunx`).
   */
  fun execute(command: List<String>, runnerDirectory: String? = null): DaemonCommandResult
}

internal object SystemDaemonCommandExecutor : DaemonCommandExecutor {
  override fun execute(command: List<String>, runnerDirectory: String?): DaemonCommandResult {
    val builder = ProcessBuilder(command).redirectErrorStream(true)
    if (runnerDirectory != null) {
      val environment = builder.environment()
      val existingPath = environment["PATH"].orEmpty()
      environment["PATH"] =
        if (existingPath.isEmpty()) runnerDirectory
        else "$runnerDirectory${File.pathSeparator}$existingPath"
    }
    val process = builder.start()
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
    try {
      if (!process.waitFor(commandTimeoutMillis(), TimeUnit.MILLISECONDS)) {
        terminate(process)
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
    } catch (_: InterruptedException) {
      terminate(process)
      process.inputStream.close()
      Thread.currentThread().interrupt()
      return DaemonCommandResult(exitCode = CANCELLED_EXIT_CODE, output = "", cancelled = true)
    }
  }

  private fun terminate(process: Process) {
    val descendants = process.toHandle().descendants().toList().asReversed()
    descendants.forEach(ProcessHandle::destroy)
    process.destroy()
    if (!process.waitFor(TERMINATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      process.destroyForcibly()
      process.waitFor(TERMINATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }
    descendants.filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly)
  }

  internal fun commandTimeoutMillis(
    startupTimeoutOverride: String? =
      System.getenv("AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS")
        ?: System.getenv("AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS")
  ): Long =
    maxOf(
      DEFAULT_COMMAND_TIMEOUT_MILLIS,
      startupTimeoutOverride
        ?.toLongOrNull()
        ?.takeIf { it > 0 }
        ?.plus(TERMINATION_TIMEOUT_SECONDS * 1_000) ?: DEFAULT_COMMAND_TIMEOUT_MILLIS,
    )

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

  private const val DEFAULT_COMMAND_TIMEOUT_MILLIS = 60_000L
  private const val TERMINATION_TIMEOUT_SECONDS = 5L
  private const val TIMEOUT_EXIT_CODE = -1
  private const val CANCELLED_EXIT_CODE = -2
}

internal interface DaemonRetryTimer {
  fun sleep(milliseconds: Long)
}

internal object SystemDaemonRetryTimer : DaemonRetryTimer {
  override fun sleep(milliseconds: Long) {
    Thread.sleep(milliseconds)
  }
}

/**
 * Resolves the package runner used to launch the pinned daemon package. AutoMobile runs on Bun, so
 * `bunx` is preferred over `npx`. Desktop apps launched from the GUI (Finder, Dock) inherit a
 * stripped PATH that omits `~/.bun/bin` and Homebrew, so the resolver probes known absolute install
 * locations before falling back to a PATH lookup — otherwise `ProcessBuilder` fails with "Cannot
 * run program" even when Bun is installed.
 */
internal interface DaemonPackageRunnerResolver {
  fun resolve(osName: String): String
}

internal class SystemDaemonPackageRunnerResolver(
  private val home: String? =
    System.getProperty("user.home")?.takeIf { it.isNotEmpty() } ?: System.getenv("HOME"),
  private val executableAt: (String) -> Boolean = { File(it).canExecute() },
  private val listDir: (String) -> List<String> = { File(it).list()?.toList().orEmpty() },
  private val onPath: (String, Boolean) -> String? = ::whichRunner,
) : DaemonPackageRunnerResolver {
  override fun resolve(osName: String): String {
    val isWindows = osName.lowercase().contains("win")
    // Bun-first: every `bunx` probe — absolute install locations AND the PATH lookup — must rank
    // ahead of every `npx` probe, so a Bun supplied on PATH by mise/asdf is never passed over for
    // an absolute npm `npx`. Only after Bun is exhausted do we fall back to Node.
    bunAbsoluteCandidates(isWindows)
      .firstOrNull { executableAt(it) }
      ?.let {
        return it
      }
    onPath("bunx", isWindows)?.let {
      return it
    }
    nodeAbsoluteCandidates(isWindows)
      .firstOrNull { executableAt(it) }
      ?.let {
        return it
      }
    onPath("npx", isWindows)?.let {
      return it
    }
    // Nothing resolved: emit the legacy npx name so the failure surfaces actionable guidance.
    return if (isWindows) "npx.cmd" else "npx"
  }

  private fun bunAbsoluteCandidates(isWindows: Boolean): List<String> =
    if (isWindows) {
      buildList { home?.let { add("$it\\.bun\\bin\\bunx.exe") } }
    } else {
      buildList {
        home?.let { add("$it/.bun/bin/bunx") }
        add("/opt/homebrew/bin/bunx")
        add("/usr/local/bin/bunx")
      }
    }

  /**
   * Node `npx` fallbacks, highest-precedence first. An nvm-installed Node is resolved by scanning
   * `~/.nvm/versions/node/<version>/bin` newest-version first — nvm only publishes a `current`
   * symlink when `NVM_SYMLINK_CURRENT=true` (off by default), and a detached GUI process cannot
   * observe the shell-active version, so the newest installed version is the deterministic proxy.
   */
  private fun nodeAbsoluteCandidates(isWindows: Boolean): List<String> =
    if (isWindows) {
      emptyList()
    } else {
      buildList {
        add("/opt/homebrew/bin/npx")
        add("/usr/local/bin/npx")
        home?.let { h ->
          val nvmNodeDir = "$h/.nvm/versions/node"
          nvmNodeVersionsNewestFirst(nvmNodeDir).forEach { version ->
            add("$nvmNodeDir/$version/bin/npx")
          }
          add("$h/.volta/bin/npx")
        }
      }
    }

  private fun nvmNodeVersionsNewestFirst(nvmNodeDir: String): List<String> =
    listDir(nvmNodeDir).filter { it.startsWith("v") }.sortedWith(NVM_VERSION_ORDER.reversed())

  private companion object {
    /**
     * Ascending numeric order over dotted version dirs (`v20.11.1`); unparseable parts sort as 0.
     */
    val NVM_VERSION_ORDER: Comparator<String> = Comparator { left, right ->
      val leftParts = versionParts(left)
      val rightParts = versionParts(right)
      for (index in 0 until maxOf(leftParts.size, rightParts.size)) {
        val difference =
          leftParts.getOrElse(index) { 0 }.compareTo(rightParts.getOrElse(index) { 0 })
        if (difference != 0) return@Comparator difference
      }
      0
    }

    private fun versionParts(version: String): List<Int> =
      version.removePrefix("v").split('.', '-').mapNotNull { it.toIntOrNull() }

    fun whichRunner(runner: String, isWindows: Boolean): String? {
      val locator = if (isWindows) "where" else "which"
      return try {
        val process = ProcessBuilder(locator, runner).redirectErrorStream(true).start()
        if (!process.waitFor(2, TimeUnit.SECONDS)) {
          process.destroy()
          return null
        }
        if (process.exitValue() != 0) return null
        process.inputStream
          .bufferedReader()
          .readText()
          .lineSequence()
          .map { it.trim() }
          .firstOrNull { it.isNotEmpty() }
      } catch (_: Exception) {
        null
      }
    }
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
  private val packageRunnerResolver: DaemonPackageRunnerResolver =
    SystemDaemonPackageRunnerResolver(),
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
      val currentDaemon =
        when (val readResult = readPidStateWithRetry()) {
          is DaemonPidReadResult.Present -> readResult.state
          DaemonPidReadResult.Absent -> null
          DaemonPidReadResult.Unreadable ->
            return DaemonLifecycleResult.Failure(
              "Could not read the AutoMobile daemon state. Wait a moment for startup to finish, then retry."
            )
        }
      val currentVersion = currentDaemon?.version
      val daemonAvailable = socketIsReady(currentVersion, expectedVersion)
      if (daemonAvailable && versionsMatch(currentVersion, expectedVersion)) {
        return DaemonLifecycleResult.Ready(restarted = false)
      }

      if (daemonAvailable && daemonIsNewer(currentVersion, expectedVersion)) {
        return DaemonLifecycleResult.Failure(
          "AutoMobile daemon $currentVersion is newer than desktop $expectedVersion. " +
            "Update the desktop application before connecting."
        )
      }

      if (declaresFullVersion(expectedVersion)) {
        return DaemonLifecycleResult.Failure(
          "AutoMobile desktop source build $expectedVersion cannot start a matching published daemon. " +
            "Start the daemon from the same checkout, then try again."
        )
      }

      val action = if (daemonAvailable) "restart" else "start"
      val commandResult =
        try {
          val launch =
            packageDaemonCommand(expectedVersion, action, currentDaemon?.launchArguments.orEmpty())
          commandExecutor.execute(launch.command, launch.runnerDirectory)
        } catch (error: Exception) {
          return DaemonLifecycleResult.Failure(
            "Could not $action AutoMobile $expectedVersion: ${error.message ?: error.javaClass.simpleName}. " +
              "Install Bun (recommended) or Node.js so bunx/npx is available, then try again."
          )
        }
      if (commandResult.cancelled) {
        return DaemonLifecycleResult.Failure("AutoMobile daemon startup was cancelled.")
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
        actualVersion = (pidFileReader.read() as? DaemonPidReadResult.Present)?.state?.version
        if (socketChecker.isReady() && versionsMatch(actualVersion, expectedVersion)) {
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
  ): DaemonLaunchCommand {
    val osName = System.getProperty("os.name", "")
    val runner = packageRunnerResolver.resolve(osName)
    val runnerArguments = buildList {
      add(runner)
      // Bun's `bunx` auto-installs without prompting; only npm's `npx` needs `-y`.
      if (usesYesFlag(runner)) add("-y")
      add("@kaeawc/auto-mobile@${DaemonSocketPaths.releaseVersion(version)}")
      add("--daemon")
      add(action)
      addAll(existingOptions)
    }
    // A bare runner name (the unresolved fallback) has no directory to publish onto PATH.
    return DaemonLaunchCommand(commandForPlatform(runnerArguments, osName), File(runner).parent)
  }

  internal fun usesYesFlag(runner: String): Boolean =
    File(runner).nameWithoutExtension.lowercase() == "npx"

  private fun readPidStateWithRetry(): DaemonPidReadResult {
    repeat(PID_READ_ATTEMPTS) { attempt ->
      val result = pidFileReader.read()
      if (result != DaemonPidReadResult.Unreadable) return result
      if (attempt + 1 < PID_READ_ATTEMPTS) timer.sleep(PID_READ_RETRY_DELAY_MS)
    }
    return DaemonPidReadResult.Unreadable
  }

  private fun socketIsReady(
    currentVersion: String?,
    expectedVersion: String,
  ): Boolean {
    repeat(SOCKET_PROBE_ATTEMPTS) { attempt ->
      if (socketChecker.isReady()) return true
      if (attempt + 1 < SOCKET_PROBE_ATTEMPTS) timer.sleep(SOCKET_PROBE_RETRY_DELAY_MS)
    }
    return false
  }

  private fun daemonIsNewer(
    currentVersion: String?,
    expectedVersion: String,
  ): Boolean {
    val currentRelease = currentVersion?.let(DaemonSocketPaths::releaseVersion).orEmpty()
    val expectedRelease = DaemonSocketPaths.releaseVersion(expectedVersion)
    val currentParts = currentRelease.split('.').map { it.toIntOrNull() ?: return false }
    val expectedParts = expectedRelease.split('.').map { it.toIntOrNull() ?: return false }
    val length = maxOf(currentParts.size, expectedParts.size)
    for (index in 0 until length) {
      val difference =
        (currentParts.getOrElse(index) { 0 }).compareTo(expectedParts.getOrElse(index) { 0 })
      if (difference != 0) return difference > 0
    }
    return false
  }

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

  internal fun commandForPlatform(command: List<String>, osName: String): List<String> {
    if (!osName.lowercase().contains("win")) return command
    val quotedCommand = command.joinToString(" ") { quoteForWindowsCmd(it) }
    return listOf("cmd.exe", "/d", "/v:off", "/s", "/c", "\"$quotedCommand\"")
  }

  private fun quoteForWindowsCmd(value: String): String {
    require(!value.contains('"') && !value.contains('\n') && !value.contains('\r')) {
      "AutoMobile daemon arguments cannot contain Windows command-line quotes or newlines"
    }
    return "\"${value.replace("%", "%%")}\""
  }

  private companion object {
    val lifecycleLock = Any()
    const val DEFAULT_VERIFICATION_ATTEMPTS = 20
    const val VERIFICATION_RETRY_DELAY_MS = 100L
    const val PID_READ_ATTEMPTS = 3
    const val PID_READ_RETRY_DELAY_MS = 100L
    const val SOCKET_PROBE_ATTEMPTS = 3
    const val SOCKET_PROBE_RETRY_DELAY_MS = 150L
  }
}
