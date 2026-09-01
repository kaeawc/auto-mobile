package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.net.URI
import java.net.UnixDomainSocketAddress
import java.nio.channels.SocketChannel
import java.nio.file.Files
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
  ): Long {
    val startupTimeoutMillis =
      startupTimeoutOverride?.toLongOrNull()?.takeIf { it > 0 }
        ?: DEFAULT_DAEMON_STARTUP_TIMEOUT_MILLIS
    return (startupTimeoutMillis.coerceAtMost(
      (Long.MAX_VALUE - TERMINATION_TIMEOUT_MILLIS) / DAEMON_STARTUP_LIFECYCLE_BUDGETS
    ) * DAEMON_STARTUP_LIFECYCLE_BUDGETS) + TERMINATION_TIMEOUT_MILLIS
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

  private const val DEFAULT_DAEMON_STARTUP_TIMEOUT_MILLIS = 30_000L
  private const val DAEMON_STARTUP_LIFECYCLE_BUDGETS = 3L
  private const val TERMINATION_TIMEOUT_SECONDS = 5L
  private const val TERMINATION_TIMEOUT_MILLIS = TERMINATION_TIMEOUT_SECONDS * 1_000
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
 * Resolves the `bunx` runner used to launch the pinned daemon package. AutoMobile runs exclusively
 * on Bun. It prefers the `bunx` the user's PATH resolves (their configured install) and falls back
 * to known absolute install locations for GUI-launched apps (Finder, Dock) whose PATH is stripped —
 * otherwise `ProcessBuilder` fails with "Cannot run program" even when Bun is installed.
 */
internal interface DaemonPackageRunnerResolver {
  fun resolve(osName: String): String?
}

internal class SystemDaemonPackageRunnerResolver(
  private val home: String? =
    System.getProperty("user.home")?.takeIf { it.isNotEmpty() } ?: System.getenv("HOME"),
  private val bunInstall: String? = System.getenv("BUN_INSTALL")?.takeIf { it.isNotEmpty() },
  private val executableAt: (String) -> Boolean = { File(it).canExecute() },
  private val onPath: (String, Boolean) -> String? = ::whichRunner,
) : DaemonPackageRunnerResolver {
  override fun resolve(osName: String): String? {
    val isWindows = osName.lowercase().startsWith("windows")
    // Prefer the `bunx` the user's PATH resolves (their configured install, e.g. via mise/asdf),
    // then the hard-coded absolute install locations as a fallback for GUI-launched apps whose PATH
    // is stripped (there `which/where` returns nothing, so we still land on the known install).
    onPath("bunx", isWindows)?.let {
      return it
    }
    bunAbsoluteCandidates(isWindows)
      .firstOrNull { executableAt(it) }
      ?.let {
        return it
      }
    return null
  }

  private fun bunAbsoluteCandidates(isWindows: Boolean): List<String> =
    if (isWindows) {
      buildList {
        bunInstall?.let { add("$it\\bin\\bunx.exe") }
        home?.let { add("$it\\.bun\\bin\\bunx.exe") }
      }
    } else {
      buildList {
        bunInstall?.let { add("$it/bin/bunx") }
        home?.let { add("$it/.bun/bin/bunx") }
        add("/opt/homebrew/bin/bunx")
        add("/usr/local/bin/bunx")
        // Homebrew on Linux (Linuxbrew): the desktop ships a Linux Deb, and a desktop-session PATH
        // often omits Linuxbrew, so probe its default multi-user and per-user prefixes.
        add("/home/linuxbrew/.linuxbrew/bin/bunx")
        home?.let { add("$it/.linuxbrew/bin/bunx") }
        // Version-manager shims (mise, asdf) at their default roots — a stripped GUI PATH omits
        // these too, so a Bun installed only through mise/asdf would otherwise be missed.
        home?.let {
          add("$it/.local/share/mise/shims/bunx")
          add("$it/.asdf/shims/bunx")
        }
      }
    }

  private companion object {
    fun whichRunner(runner: String, isWindows: Boolean): String? {
      val locator = if (isWindows) "where" else "which"
      val process =
        try {
          ProcessBuilder(locator, runner).redirectErrorStream(true).start()
        } catch (_: Exception) {
          return null
        }
      return try {
        if (!process.waitFor(2, TimeUnit.SECONDS)) return null
        if (process.exitValue() != 0) return null
        selectRunnerFromLookup(
          process.inputStream.bufferedReader().readText(),
          isWindows,
          executableExtensions(),
        )
      } catch (interrupted: InterruptedException) {
        // Preserve cancellation: don't swallow the interrupt and fall through to spawning bunx.
        // Restore the flag and rethrow so a cancelled lifecycle call launches no daemon.
        Thread.currentThread().interrupt()
        throw interrupted
      } catch (_: Exception) {
        null
      } finally {
        // Terminate the locator and close its streams on every path — otherwise the timeout,
        // cancellation, and non-zero-exit branches leak file descriptors until GC.
        process.destroy()
        runCatching { process.inputStream.close() }
        runCatching { process.outputStream.close() }
        runCatching { process.errorStream.close() }
      }
    }

    private fun executableExtensions(): List<String> =
      (System.getenv("PATHEXT") ?: ".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
  }
}

internal interface BunInstallerScriptDownloader {
  fun download(url: String, target: File)
}

internal object SystemBunInstallerScriptDownloader : BunInstallerScriptDownloader {
  override fun download(url: String, target: File) {
    val connection = URI.create(url).toURL().openConnection()
    connection.connectTimeout = DOWNLOAD_CONNECT_TIMEOUT_MILLIS
    connection.readTimeout = DOWNLOAD_READ_TIMEOUT_MILLIS
    connection.getInputStream().use { input ->
      target.outputStream().use(input::copyTo)
    }
  }

  private const val DOWNLOAD_CONNECT_TIMEOUT_MILLIS = 15_000
  private const val DOWNLOAD_READ_TIMEOUT_MILLIS = 30_000
}

internal interface DesktopBunInstaller {
  fun install(osName: String): DaemonCommandResult
}

/**
 * Installs Bun from its official platform script when a desktop-first launch cannot resolve bunx.
 * The script is downloaded to a private temporary directory and passed as an argv element rather
 * than interpolated into a shell command. This mirrors scripts/install.sh while keeping network,
 * process, and temporary-file access injectable for fast tests.
 */
internal class SystemDesktopBunInstaller(
  private val downloader: BunInstallerScriptDownloader = SystemBunInstallerScriptDownloader,
  private val commandExecutor: DaemonCommandExecutor = SystemDaemonCommandExecutor,
  private val temporaryDirectoryProvider: () -> File = {
    Files.createTempDirectory("automobile-bun-install").toFile()
  },
) : DesktopBunInstaller {
  override fun install(osName: String): DaemonCommandResult {
    val isWindows = osName.lowercase().startsWith("windows")
    val isPosix =
      osName.lowercase().let { normalized ->
        normalized.contains("mac") || normalized.contains("darwin") || normalized.contains("linux")
      }
    if (!isWindows && !isPosix) {
      return DaemonCommandResult(
        exitCode = INSTALL_FAILURE_EXIT_CODE,
        output = "Automatic Bun installation is not supported on $osName.",
      )
    }

    var temporaryDirectory: File? = null
    return try {
      temporaryDirectory = temporaryDirectoryProvider()
      val script = File(temporaryDirectory, if (isWindows) "install.ps1" else "install.sh")
      downloader.download(
        if (isWindows) WINDOWS_INSTALLER_URL else POSIX_INSTALLER_URL,
        script,
      )
      val command =
        if (isWindows) {
          listOf(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.absolutePath,
          )
        } else {
          listOf("/bin/bash", script.absolutePath)
        }
      commandExecutor.execute(command)
    } catch (error: Exception) {
      DaemonCommandResult(
        exitCode = INSTALL_FAILURE_EXIT_CODE,
        output = error.message ?: error.javaClass.simpleName,
      )
    } finally {
      temporaryDirectory?.deleteRecursively()
    }
  }

  private companion object {
    const val POSIX_INSTALLER_URL = "https://bun.sh/install"
    const val WINDOWS_INSTALLER_URL = "https://bun.sh/install.ps1"
    const val INSTALL_FAILURE_EXIT_CODE = -3
  }
}

/**
 * Picks the runner path from a `where`/`which` listing. The daemon launch wraps the runner in
 * `cmd.exe /c` on Windows, which can only execute a PATHEXT entry — so only a result ending in a
 * PATHEXT extension qualifies there, and `null` is returned when none does so the resolver falls
 * back to the absolute `bunx.exe`. `which` output on POSIX is already an executable path.
 */
internal fun selectRunnerFromLookup(
  output: String,
  isWindows: Boolean,
  executableExtensions: List<String>,
): String? {
  val results = output.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
  if (!isWindows) return results.firstOrNull()
  return results.firstOrNull { candidate ->
    executableExtensions.any { candidate.endsWith(it, ignoreCase = true) }
  }
}

internal sealed interface DaemonLifecycleResult {
  data class Ready(val restarted: Boolean) : DaemonLifecycleResult

  data class Failure(val message: String) : DaemonLifecycleResult
}

/**
 * Coarse progress phases of a daemon lifecycle pass, reported through the lifecycle's
 * `phaseListener` so the UI can narrate a slow first launch (installing Bun, fetching the daemon
 * package) instead of sitting on a generic spinner. Terminal phases mirror [DaemonLifecycleResult];
 * the listener sees every pass, including per-request preflights that resolve instantly to
 * [Completed].
 */
sealed interface DaemonLifecyclePhase {
  /** Reading the pid file and probing the daemon socket. */
  data object Probing : DaemonLifecyclePhase

  /** Downloading and running the Bun installer (first launch on a machine without Bun). */
  data object InstallingRuntime : DaemonLifecyclePhase

  /** Running `bunx @kaeawc/auto-mobile@<version> --daemon <action>` (fetches the package). */
  data class LaunchingDaemon(val action: String, val version: String) : DaemonLifecyclePhase

  /** Daemon command succeeded; polling the socket until it serves the expected version. */
  data object Verifying : DaemonLifecyclePhase

  /** The pass resolved with a ready daemon. */
  data class Completed(val restarted: Boolean) : DaemonLifecyclePhase

  /** The pass resolved without a usable daemon. */
  data class Failed(val message: String) : DaemonLifecyclePhase
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
  private val bunInstaller: DesktopBunInstaller = SystemDesktopBunInstaller(),
  private val verificationAttempts: Int = DEFAULT_VERIFICATION_ATTEMPTS,
  /**
   * Observes [DaemonLifecyclePhase] transitions of every pass. Invoked under [lifecycleLock], so
   * implementations must be non-blocking (e.g. a `StateFlow.value` write).
   */
  private val phaseListener: (DaemonLifecyclePhase) -> Unit = {},
) : DaemonLifecycleEnsurer {
  override fun ensureVersionMatchedDaemon(): DaemonLifecycleResult =
    synchronized(lifecycleLock) {
      phaseListener(DaemonLifecyclePhase.Probing)
      val result = ensureLocked()
      phaseListener(
        when (result) {
          is DaemonLifecycleResult.Ready -> DaemonLifecyclePhase.Completed(result.restarted)
          is DaemonLifecycleResult.Failure -> DaemonLifecyclePhase.Failed(result.message)
        }
      )
      result
    }

  private fun ensureLocked(): DaemonLifecycleResult {
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

    if (declaresFullVersion(expectedVersion)) {
      return DaemonLifecycleResult.Failure(
        "AutoMobile desktop source build $expectedVersion cannot start a matching published daemon. " +
          "Start the daemon from the same checkout, then try again."
      )
    }

    val action = if (daemonAvailable) "restart" else "start"
    val osName = System.getProperty("os.name", "")
    var runner = packageRunnerResolver.resolve(osName)
    if (runner == null) {
      phaseListener(DaemonLifecyclePhase.InstallingRuntime)
      val installResult = bunInstaller.install(osName)
      if (installResult.cancelled) {
        return DaemonLifecycleResult.Failure("Bun installation was cancelled.")
      }
      if (installResult.timedOut) {
        return DaemonLifecycleResult.Failure(
          "Timed out while installing Bun. Check your network connection and retry."
        )
      }
      if (installResult.exitCode != 0) {
        val detail = installResult.output.trim().takeIf { it.isNotEmpty() }
        return DaemonLifecycleResult.Failure(
          buildString {
            append("Could not install Bun automatically")
            detail?.let { append(": $it") }
            append(". Install Bun manually, then try again.")
          }
        )
      }
      runner = packageRunnerResolver.resolve(osName)
      if (runner == null) {
        return DaemonLifecycleResult.Failure(
          "Bun installed, but bunx could not be found. Restart AutoMobile and try again."
        )
      }
    }
    phaseListener(DaemonLifecyclePhase.LaunchingDaemon(action, expectedVersion))
    val commandResult =
      try {
        val command =
          packageDaemonCommand(
            runner,
            expectedVersion,
            action,
            currentDaemon?.launchArguments.orEmpty(),
            osName,
          )
        commandExecutor.execute(command)
      } catch (error: Exception) {
        return DaemonLifecycleResult.Failure(
          "Could not $action AutoMobile $expectedVersion: ${error.message ?: error.javaClass.simpleName}. " +
            "Install Bun so bunx is available, then try again."
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

    phaseListener(DaemonLifecyclePhase.Verifying)
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
    runner: String,
    version: String,
    action: String,
    existingOptions: List<String>,
    osName: String,
  ): List<String> {
    // `bunx` auto-installs the pinned package without prompting, and is a self-contained native
    // binary, so it needs no `-y` flag and no PATH manipulation.
    val runnerArguments =
      listOf(
        runner,
        "@kaeawc/auto-mobile@${DaemonSocketPaths.releaseVersion(version)}",
        "--daemon",
        action,
      ) + existingOptions
    return commandForPlatform(runnerArguments, osName)
  }

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
