package dev.jasonpearson.automobile.junit

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

internal object DaemonSocketClientManager {
  // Use ThreadLocal to give each thread its own socket connection
  // This enables true parallel execution since socket server queues requests per connection
  private val threadLocalClient = ThreadLocal<DaemonSocketClient>()
  private val clientLock = Any()
  @Volatile private var daemonEnsured = false
  @JvmStatic internal var testClient: DaemonToolClient? = null

  fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse {
    val overrideClient = testClient
    if (overrideClient != null) {
      return overrideClient.callTool(toolName, arguments, timeoutMs)
    }
    return getOrCreateClient().callTool(toolName, arguments, timeoutMs)
  }

  fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    val overrideClient = testClient
    if (overrideClient != null) {
      return overrideClient.readResource(uri, timeoutMs)
    }
    return getOrCreateClient().readResource(uri, timeoutMs)
  }

  fun sessionUuid(): String {
    return testClient?.sessionUuid ?: getOrCreateClient().sessionUuid
  }

  private fun getOrCreateClient(): DaemonSocketClient {
    // Each thread gets its own connection for parallel execution
    val existing = threadLocalClient.get()
    if (existing != null && existing.isConnected()) {
      return existing
    }

    val socketPath = DaemonSocketPaths.socketPath()

    // Ensure daemon is running (restart if socket disappeared after crash/exit)
    synchronized(clientLock) {
      // Reset daemonEnsured if socket doesn't exist (daemon crashed/exited)
      if (!File(socketPath).exists()) {
        daemonEnsured = false
      }

      if (!daemonEnsured) {
        ensureDaemonRunning()
        daemonEnsured = true
      }
    }

    // Create new client for this thread
    val newClient = DaemonSocketClient(socketPath)
    threadLocalClient.set(newClient)
    return newClient
  }

  private fun ensureDaemonRunning() {
    val socketPath = DaemonSocketPaths.socketPath()
    val forceRestart = DaemonSocketPaths.resolveForceRestart()
    val daemonAvailable = DaemonSocketClient.isAvailable(socketPath)
    val daemonAssetVersion =
      DaemonSocketPaths.readDaemonAssetVersionFromPidFile(DaemonSocketPaths.pidFilePath())
    val callerAssetVersion = DaemonSocketPaths.resolveCallerAssetVersionPin()
    val assetVersionSkew =
      daemonAvailable &&
        DaemonSocketPaths.requiresAssetVersionPinFailure(
          daemonAssetVersion,
          callerAssetVersion,
        )

    // A daemon of a different build already owning the shared per-uid socket would
    // silently serve the wrong tool set (#2744). Before reusing it, compare the version
    // (and, for local overrides, the entry-script build identity) it recorded in its PID
    // file against this runner's and restart on skew, mirroring the MCP proxy's
    // ensureVersionMatches/ensureBuildMatches.
    val pidFilePath = DaemonSocketPaths.pidFilePath()
    val versionSkew =
      daemonAvailable &&
        DaemonSocketPaths.requiresVersionSkewRestart(
          DaemonSocketPaths.readDaemonVersionFromPidFile(pidFilePath),
          DaemonSocketPaths.resolveClientVersion(),
        )
    // Two checkouts at the same release version (e.g. a stale `0.0.40+gold` daemon vs this
    // local `0.0.40`) are indistinguishable by release alone; the entry-script hash catches them.
    val buildSkew =
      daemonAvailable &&
        DaemonSocketPaths.requiresBuildSkewRestart(
          DaemonSocketPaths.readDaemonBuildIdFromPidFile(pidFilePath),
          DaemonSocketPaths.readDaemonEntryScriptFromPidFile(pidFilePath),
          DaemonSocketPaths.resolveClientBuildId(),
          DaemonSocketPaths.resolveLocalDaemonEntryScript(),
        )
    if (
      DaemonSocketPaths.requiresImmediateAssetVersionPinFailure(
        assetVersionSkew,
        versionSkew,
        buildSkew,
        forceRestart,
      )
    ) {
      throw DaemonUnavailableException(
        "AutoMobile daemon AUTOMOBILE_VERSION mismatch: the shared daemon was started with " +
          "${daemonAssetVersion ?: "unknown"}, but this runner requested $callerAssetVersion. " +
          "Restart the daemon from this runner's environment before reusing it."
      )
    }
    val skew = versionSkew || buildSkew || assetVersionSkew

    if (!forceRestart && daemonAvailable && !skew) {
      return
    }

    val startCommand =
      if (forceRestart || skew) {
        DaemonSocketPaths.buildDaemonRestartCommand()
      } else {
        DaemonSocketPaths.buildDaemonStartCommand()
      }
    val debugMode = SystemPropertyCache.getBoolean("automobile.debug", false)
    if (skew && debugMode) {
      println("Restarting AutoMobile daemon due to version/build skew with runner")
    }
    if (debugMode) {
      println("Starting AutoMobile daemon with: ${startCommand.joinToString(" ")}")
    }

    val environmentOverrides = resolveDaemonEnvironmentOverrides()
    AutoMobileSharedUtils.executeCommand(
      startCommand,
      DaemonSocketPaths.daemonLauncherTimeoutMs(),
      environmentOverrides,
    )

    val started =
      DaemonSocketClient.waitForAvailability(
        socketPath,
        DaemonSocketPaths.daemonStartTimeoutMs(),
      )
    if (!started) {
      throw DaemonUnavailableException(
        "Daemon failed to start within ${DaemonSocketPaths.daemonStartTimeoutMs()}ms"
      )
    }

    // executeCommand returns a CommandResult rather than throwing, and waitForAvailability only
    // confirms socket liveness — a failed versioned bunx/npx restart that leaves the stale socket
    // up, or a PATH `auto-mobile` fallback of a different version, would look "ready" while the
    // daemon's handshake gate (#2744) rejects every request carrying clientVersion/clientBuildId.
    // Confirm the running daemon's version AND build identity match this runner before marking it
    // ensured; a daemon that records no version/build id is accepted (a skew cannot be proven).
    val stillVersionSkewed =
      DaemonSocketPaths.requiresVersionSkewRestart(
        DaemonSocketPaths.readDaemonVersionFromPidFile(pidFilePath),
        DaemonSocketPaths.resolveClientVersion(),
      )
    val stillBuildSkewed =
      DaemonSocketPaths.requiresBuildSkewRestart(
        DaemonSocketPaths.readDaemonBuildIdFromPidFile(pidFilePath),
        DaemonSocketPaths.readDaemonEntryScriptFromPidFile(pidFilePath),
        DaemonSocketPaths.resolveClientBuildId(),
        DaemonSocketPaths.resolveLocalDaemonEntryScript(),
      )
    val stillAssetVersionSkewed =
      DaemonSocketPaths.requiresAssetVersionPinFailure(
        DaemonSocketPaths.readDaemonAssetVersionFromPidFile(pidFilePath),
        DaemonSocketPaths.resolveCallerAssetVersionPin(),
      )
    if (stillVersionSkewed || stillBuildSkewed || stillAssetVersionSkewed) {
      throw DaemonUnavailableException(
        "AutoMobile daemon still differs from this runner after (re)start; the shared socket is " +
          "served by a different build. Ensure the same @kaeawc/auto-mobile version starts the " +
          "daemon and runs the tests (e.g. set automobile.daemon.package.version)."
      )
    }

    // NOTE: Device pool initialization check removed to allow parallel test execution.
    // The daemon initializes its device pool at startup, and tests will wait for
    // devices as needed when they call executePlan.
  }

  /**
   * Wait for daemon device pool to have at least one device This is a blocking health check that
   * prevents tests from running until devices are available.
   */
  private fun waitForDevicePoolReady(timeoutMs: Long) {
    val debugMode = SystemPropertyCache.getBoolean("automobile.debug", false)
    val json = Json { ignoreUnknownKeys = true }
    if (debugMode) {
      println("Waiting for daemon device pool to initialize...")
    }

    val startTime = System.currentTimeMillis()
    var lastDeviceCount = -1
    var nextRefreshTime = startTime + 2000 // First refresh after 2 seconds

    while (System.currentTimeMillis() - startTime < timeoutMs) {
      try {
        val socketClient = DaemonSocketClient(DaemonSocketPaths.socketPath())

        // Trigger device refresh every 2 seconds if pool is still empty
        val now = System.currentTimeMillis()
        if (now >= nextRefreshTime && lastDeviceCount == 0) {
          if (debugMode) {
            println("Triggering device pool refresh...")
          }
          try {
            val refreshResponse = socketClient.callDaemonMethod("daemon/refreshDevices", 5000)
            if (debugMode && refreshResponse.success) {
              val addedDevices =
                refreshResponse.result?.jsonObject?.get("addedDevices")?.jsonPrimitive?.intOrNull
                  ?: 0
              println("Device pool refresh complete: added $addedDevices devices")
            }
          } catch (e: Exception) {
            if (debugMode) {
              println("Device refresh error: ${e.message}")
            }
          }
          nextRefreshTime = now + 2000 // Schedule next refresh in 2 seconds
        }

        val response =
          socketClient.callTool(
            "listDevices",
            JsonObject(mapOf("platform" to JsonPrimitive("android"))),
            5000,
          )
        socketClient.close()

        if (response.success) {
          val payloadText =
            response.result
              ?.jsonObject
              ?.get("content")
              ?.jsonArray
              ?.firstOrNull()
              ?.jsonObject
              ?.get("text")
              ?.jsonPrimitive
              ?.content
          val parsedResult = payloadText?.let { json.parseToJsonElement(it).jsonObject }
          val poolStatus = parsedResult?.get("poolStatus")?.jsonObject
          val totalDevices =
            poolStatus?.get("total")?.jsonPrimitive?.intOrNull
              ?: parsedResult?.get("totalCount")?.jsonPrimitive?.intOrNull
              ?: 0

          if (totalDevices > 0) {
            if (debugMode) {
              println("Device pool ready with $totalDevices device(s)")
            }
            return
          }

          // Log only if device count changed
          if (totalDevices != lastDeviceCount) {
            if (debugMode) {
              println("Device pool still empty, waiting...")
            }
            lastDeviceCount = totalDevices
          }
        }
      } catch (e: Exception) {
        // Ignore errors during health check, will retry
        if (debugMode) {
          println("Device pool check error: ${e.message}")
        }
      }

      Thread.sleep(500)
    }

    // Device pool is still empty after timeout - throw error
    throw DaemonUnavailableException(
      "Daemon device pool is empty after ${timeoutMs}ms. " +
        "Start an emulator or connect a physical device before running tests."
    )
  }

  private fun resolveDaemonEnvironmentOverrides(): Map<String, String> {
    val resolvedOverrides = mutableMapOf<String, String>()
    val ctrlProxyApkProperty = SystemPropertyCache.get("automobile.ctrl.proxy.apk.path", "").trim()
    val ctrlProxyApkEnv = System.getenv("AUTOMOBILE_CTRL_PROXY_APK_PATH")?.trim().orEmpty()
    val ctrlProxyApkPath =
      when {
        ctrlProxyApkProperty.isNotEmpty() -> ctrlProxyApkProperty
        ctrlProxyApkEnv.isNotEmpty() -> ctrlProxyApkEnv
        else -> findLocalCtrlProxyApkPath().orEmpty()
      }
    if (ctrlProxyApkPath.isNotEmpty()) {
      resolvedOverrides["AUTOMOBILE_CTRL_PROXY_APK_PATH"] = ctrlProxyApkPath
    }
    return resolvedOverrides
  }

  private fun findLocalCtrlProxyApkPath(): String? {
    val candidates =
      listOf(
        File("control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"),
        File("../control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"),
        File("../../control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"),
      )
    return candidates.firstOrNull { it.exists() }?.absolutePath
  }
}

internal object DaemonSocketPaths {
  private const val DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 30000L
  private const val DAEMON_STARTUP_LIFECYCLE_BUDGETS = 3L
  private const val DAEMON_PACKAGE_NAME = "@kaeawc/auto-mobile"
  private const val DAEMON_PACKAGE_VERSION_PROPERTY = "automobile.daemon.package.version"
  private val ignoredPackageVersions = setOf("latest", "unknown")

  fun socketPath(): String {
    val userId = getUserId()
    return "/tmp/auto-mobile-daemon-$userId.sock"
  }

  fun daemonStartTimeoutMs(): Long {
    // Check system property first, then environment variable
    val sysProp = SystemPropertyCache.get("automobile.daemon.startup.timeout.ms", "")
    val envVar = System.getenv("AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS")?.trim().orEmpty()
    val configured =
      sysProp.ifEmpty { envVar }.ifEmpty { DEFAULT_DAEMON_STARTUP_TIMEOUT_MS.toString() }
    return configured.toLongOrNull() ?: DEFAULT_DAEMON_STARTUP_TIMEOUT_MS
  }

  /**
   * Bound the launcher process for the daemon's full startup lifecycle: one
   * lock-holder wait plus up to two startup attempts.
   */
  fun daemonLauncherTimeoutMs(): Long {
    return (
      daemonStartTimeoutMs()
        .coerceAtMost(Long.MAX_VALUE / DAEMON_STARTUP_LIFECYCLE_BUDGETS)
      ) * DAEMON_STARTUP_LIFECYCLE_BUDGETS
  }

  fun buildDaemonStartCommand(): List<String> {
    return buildDaemonCommand("start")
  }

  fun buildDaemonRestartCommand(): List<String> {
    return buildDaemonCommand("restart")
  }

  private fun buildDaemonCommand(subCommand: String): List<String> {
    val command =
      resolveLocalCommand(subCommand)
        ?: resolvePackageCommand(subCommand)
        ?: listOf("auto-mobile", "--daemon", subCommand)

    return command
      .withDismissKeyboardAfterInput()
      .withNoUiPerfMode()
      .withNoNavigationScreenshots()
      .withNoWaitForPollingOverhead()
      .withNoIncludeNotImportantViews()
      .withNoReportViewIds()
      .withNoRetrieveInteractiveWindows()
  }

  private fun resolveLocalCommand(subCommand: String): List<String>? {
    val projectRoot = resolveLocalDaemonProjectRoot() ?: return null
    val runtime = resolveRuntimePath()
    return listOf(
      runtime,
      File(projectRoot, "dist/src/index.js").absolutePath,
      "--daemon",
      subCommand,
    )
  }

  /**
   * The local checkout root when `automobile.daemon.local.project.path` (or its env) points at a
   * directory whose built daemon entrypoint exists — i.e. when [buildDaemonCommand] will actually
   * start the *local* daemon instead of the published package. Null otherwise.
   */
  private fun resolveLocalDaemonProjectRoot(): File? {
    val localPath = resolveLocalProjectPath() ?: return null
    val projectRoot = File(localPath)
    if (!File(projectRoot, "dist/src/index.js").exists()) return null
    return projectRoot
  }

  /** Read the `version` field from a checkout's `package.json`, or null if absent/unreadable. */
  private fun resolveLocalPackageVersion(projectRoot: File): String? {
    return try {
      val packageJson = File(projectRoot, "package.json")
      if (!packageJson.exists()) return null
      Json { ignoreUnknownKeys = true }
        .parseToJsonElement(packageJson.readText())
        .jsonObject["version"]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
      null
    }
  }

  private fun resolvePackageCommand(subCommand: String): List<String>? {
    val runner = resolvePackageRunner() ?: return null
    return buildPackageDaemonCommand(runner, subCommand)
  }

  internal fun buildPackageDaemonCommand(
    runner: String,
    subCommand: String,
    packageVersion: String? = resolveDaemonPackageVersion(),
  ): List<String>? {
    val packageSpecifier = resolveDaemonPackageSpecifier(packageVersion) ?: return null
    return if (File(runner).nameWithoutExtension == "npx") {
      listOf(runner, "-y", packageSpecifier, "--daemon", subCommand)
    } else {
      listOf(runner, packageSpecifier, "--daemon", subCommand)
    }
  }

  private fun resolveDaemonPackageSpecifier(packageVersion: String?): String? {
    val trimmedVersion = packageVersion?.trim().orEmpty()
    if (trimmedVersion.isEmpty() || ignoredPackageVersions.contains(trimmedVersion.lowercase())) {
      return null
    }
    return "$DAEMON_PACKAGE_NAME@$trimmedVersion"
  }

  internal fun resolveDaemonPackageVersion(): String? {
    val sysProp = SystemPropertyCache.get(DAEMON_PACKAGE_VERSION_PROPERTY, "").trim()
    if (sysProp.isNotEmpty()) return sysProp

    val daemonPackageEnv = System.getenv("AUTOMOBILE_DAEMON_PACKAGE_VERSION")?.trim().orEmpty()
    if (daemonPackageEnv.isNotEmpty()) return daemonPackageEnv

    val automobileVersionEnv = System.getenv("AUTOMOBILE_VERSION")?.trim().orEmpty()
    if (automobileVersionEnv.isNotEmpty()) return automobileVersionEnv

    return DaemonSocketPaths::class.java.`package`?.implementationVersion?.trim()
  }

  /**
   * Version this runner declares to the daemon for the server-side handshake gate (#2744).
   *
   * Must describe the daemon this runner will actually *start*, else the daemon rejects every
   * request. When a local project override is active, [buildDaemonCommand] starts
   * `<local>/dist/src/index.js` — whose version is the local checkout's, not this runner jar's — so
   * declare the local `package.json` version (falling back to omitting, i.e. a legacy ungated
   * client, when it can't be read) rather than the jar `Implementation-Version` the published
   * package path would use. This was the #2749 review's local-override rejection.
   */
  internal fun resolveClientVersion(): String? {
    val localProjectRoot = resolveLocalDaemonProjectRoot()
    val resolved =
      if (localProjectRoot != null) {
        resolveLocalPackageVersion(localProjectRoot)
      } else {
        resolveDaemonPackageVersion()
      }
    val trimmed = resolved?.trim().orEmpty()
    // Aliases like `latest`/`unknown` are not real versions — resolveDaemonPackageSpecifier()
    // already treats them as unpinnable and starts bare `auto-mobile`. Declaring one as
    // clientVersion would make the gate (and the post-start skew check) compare e.g. `latest`
    // against `0.0.40` and reject, so behave as an unversioned (legacy, ungated) client instead.
    if (trimmed.isEmpty() || ignoredPackageVersions.contains(trimmed.lowercase())) {
      return null
    }
    return trimmed
  }

  /**
   * Resolve whether to force a daemon restart before reuse. Explicit configuration wins (JVM
   * property `automobile.daemon.force.restart` or env `AUTOMOBILE_DAEMON_FORCE_RESTART`); otherwise
   * CI runs default to true so a stale daemon left by a previous job is replaced rather than
   * silently reused (#2744 interim). See [shouldForceRestart] for the decision.
   */
  fun resolveForceRestart(): Boolean {
    val property = SystemPropertyCache.get("automobile.daemon.force.restart", "").ifBlank { null }
    val env = System.getenv("AUTOMOBILE_DAEMON_FORCE_RESTART")
    val ci = System.getenv("CI")
    return shouldForceRestart(property, env, ci)
  }

  /**
   * Pure force-restart decision. Explicit property/env values (parsed as booleans) win in order;
   * when neither is set, a truthy `CI` marker defaults to true. Unset/blank/unparseable values fall
   * through, defaulting to false outside CI.
   */
  internal fun shouldForceRestart(
    propertyValue: String?,
    envValue: String?,
    ciValue: String?,
  ): Boolean {
    parseBooleanFlag(propertyValue)?.let {
      return it
    }
    parseBooleanFlag(envValue)?.let {
      return it
    }
    return parseBooleanFlag(ciValue) ?: false
  }

  private fun parseBooleanFlag(value: String?): Boolean? {
    val normalized = value?.trim()?.lowercase() ?: return null
    return when (normalized) {
      "1",
      "true",
      "yes",
      "y" -> true
      "0",
      "false",
      "no",
      "n" -> false
      else -> null
    }
  }

  /** PID file the daemon writes its identity to. Mirrors [socketPath] (per-uid, /tmp). */
  fun pidFilePath(): String {
    val userId = getUserId()
    return "/tmp/auto-mobile-daemon-$userId.pid"
  }

  /**
   * The release portion of a version string — everything before the semver `+g<sha>` dev stamp.
   * Mirrors the daemon's `releaseVersion`, so a git-stamped source-checkout daemon and a
   * plain-versioned runner compare equal at the same release.
   */
  internal fun releaseVersion(version: String): String = version.substringBefore('+')

  /** Read the daemon's recorded version from its PID file, or null if absent/unreadable. */
  internal fun readDaemonVersionFromPidFile(path: String): String? =
    readPidFileString(path, "version")

  /** Read the daemon's recorded CtrlProxy asset version from its PID file, or null. */
  internal fun readDaemonAssetVersionFromPidFile(path: String): String? =
    readPidFileString(path, "assetVersion")

  /** Read the daemon's recorded build-identity hash from its PID file, or null. */
  internal fun readDaemonBuildIdFromPidFile(path: String): String? =
    readPidFileString(path, "buildId")

  /** Read the daemon's recorded entry-script path from its PID file, or null. */
  internal fun readDaemonEntryScriptFromPidFile(path: String): String? =
    readPidFileString(path, "entryScript")

  private fun readPidFileString(path: String, field: String): String? {
    return try {
      val file = File(path)
      if (!file.exists()) return null
      Json { ignoreUnknownKeys = true }
        .parseToJsonElement(file.readText())
        .jsonObject[field]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
      null
    }
  }

  /**
   * Entry script the local-override daemon runs (`<local>/dist/src/index.js`), or null when no
   * local override is active. This is the file whose content hash forms the build identity.
   */
  internal fun resolveLocalDaemonEntryScript(): String? =
    resolveLocalDaemonProjectRoot()?.let { File(it, "dist/src/index.js").absolutePath }

  /**
   * Build identity (short content hash of the started daemon's entry script) this runner declares
   * for the handshake gate. Only resolvable for a local override — the published-package daemon's
   * entry script lives in an npm cache this runner cannot hash — so a package-path runner stays a
   * version-only client. Mirrors the TS `computeBuildIdentity` (sha256, first 16 hex chars) so the
   * daemon's own build id compares equal.
   */
  internal fun resolveClientBuildId(): String? =
    resolveLocalDaemonEntryScript()?.let { computeBuildId(File(it)) }

  private fun computeBuildId(entryScript: File): String? {
    return try {
      if (!entryScript.exists()) return null
      val digest = MessageDigest.getInstance("SHA-256").digest(entryScript.readBytes())
      digest.joinToString("") { "%02x".format(it) }.substring(0, 16)
    } catch (e: Exception) {
      null
    }
  }

  /**
   * Whether an already-running daemon must be restarted because its recorded build identity differs
   * from this runner's — two checkouts at the *same* release version (e.g. `0.0.40+gold` vs a local
   * `0.0.40`) that the release-only version check cannot tell apart (#2744). Mirrors the daemon's
   * `buildIdentitiesMatch`: compare content hashes when both are known, else fall back to comparing
   * entry-script paths (so a daemon whose hash is `unknown` but whose recorded entry script differs
   * still triggers a restart), else treat as a match to avoid thrashing an unidentifiable daemon.
   */
  internal fun requiresBuildSkewRestart(
    daemonBuildId: String?,
    daemonEntryScript: String?,
    clientBuildId: String?,
    clientEntryScript: String?,
  ): Boolean {
    val daemonHash = daemonBuildId?.trim().orEmpty()
    val clientHash = clientBuildId?.trim().orEmpty()
    val daemonHashKnown = daemonHash.isNotEmpty() && daemonHash != "unknown"
    val clientHashKnown = clientHash.isNotEmpty() && clientHash != "unknown"
    if (daemonHashKnown && clientHashKnown) {
      return daemonHash != clientHash
    }
    val daemonEntry = daemonEntryScript?.trim().orEmpty()
    val clientEntry = clientEntryScript?.trim().orEmpty()
    if (daemonEntry.isNotEmpty() && clientEntry.isNotEmpty()) {
      return daemonEntry != clientEntry
    }
    return false
  }

  /**
   * Whether an already-running daemon must be restarted before reuse because its recorded version
   * does not match this runner's (#2744). Compares release portions (stripping the dev stamp),
   * mirroring the MCP proxy's `ensureVersionMatches`. A blank/unknown version on either side yields
   * false: without both versions the skew cannot be proven, and forcing a restart would thrash a
   * daemon we cannot identify (matches the daemon gate's lenient "unknown => allow" stance).
   */
  internal fun requiresVersionSkewRestart(daemonVersion: String?, clientVersion: String?): Boolean {
    val daemonBase = releaseVersion(daemonVersion?.trim().orEmpty())
    val clientBase = releaseVersion(clientVersion?.trim().orEmpty())
    if (daemonBase.isEmpty() || clientBase.isEmpty()) return false
    return daemonBase != clientBase
  }

  internal fun resolveCallerAssetVersionPin(): String? {
    val pinned = System.getenv("AUTOMOBILE_VERSION")?.trim().orEmpty()
    if (pinned.isEmpty() || ignoredPackageVersions.contains(pinned.lowercase())) {
      return null
    }
    return pinned
  }

  internal fun requiresAssetVersionPinFailure(
    daemonAssetVersion: String?,
    callerPinnedVersion: String?,
  ): Boolean {
    val daemon = daemonAssetVersion?.trim().orEmpty()
    val caller = callerPinnedVersion?.trim().orEmpty()
    if (caller.isEmpty() || ignoredPackageVersions.contains(caller.lowercase())) {
      return false
    }
    return daemon != caller
  }

  internal fun requiresImmediateAssetVersionPinFailure(
    assetVersionSkew: Boolean,
    versionSkew: Boolean,
    buildSkew: Boolean,
    forceRestart: Boolean,
  ): Boolean {
    return assetVersionSkew && !versionSkew && !buildSkew && !forceRestart
  }

  /**
   * When true, the spawned daemon passes `--dismiss-keyboard-after-input` so every `inputText` call
   * hides the soft keyboard after injection (Android emulator CI often leaves it open otherwise).
   *
   * Configured via JVM system property `automobile.daemon.dismiss.keyboard.after.input` (e.g.
   * `./gradlew -Dautomobile.daemon.dismiss.keyboard.after.input=true`) or environment variable
   * `AUTOMOBILE_DAEMON_DISMISS_KEYBOARD_AFTER_INPUT`.
   */
  private fun dismissKeyboardAfterInputRequested(): Boolean {
    if (SystemPropertyCache.getBoolean("automobile.daemon.dismiss.keyboard.after.input", false)) {
      return true
    }
    val env =
      System.getenv("AUTOMOBILE_DAEMON_DISMISS_KEYBOARD_AFTER_INPUT")?.trim()?.lowercase().orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withDismissKeyboardAfterInput(): List<String> {
    if (!dismissKeyboardAfterInputRequested()) return this
    return this + "--dismiss-keyboard-after-input"
  }

  /**
   * When true, the spawned daemon passes `--no-ui-perf-mode` so CI / emulator runs skip UI
   * performance audit paths. Matches manual `bun … --daemon start --no-ui-perf-mode` when the
   * runner performs `--daemon restart`.
   */
  private fun noUiPerfModeRequested(): Boolean {
    if (SystemPropertyCache.getBoolean("automobile.daemon.no.ui.perf.mode", false)) {
      return true
    }
    val env = System.getenv("AUTOMOBILE_DAEMON_NO_UI_PERF")?.trim()?.lowercase().orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withNoUiPerfMode(): List<String> {
    if (!noUiPerfModeRequested()) return this
    return this + "--no-ui-perf-mode"
  }

  /**
   * When true, the spawned daemon passes `--no-navigation-screenshots` to disable screenshot
   * capture on navigation events. Reduces emulator resource usage in CI where navigation graph
   * thumbnails are not needed.
   */
  private fun noNavigationScreenshotsRequested(): Boolean {
    if (SystemPropertyCache.getBoolean("automobile.daemon.no.navigation.screenshots", false)) {
      return true
    }
    val env =
      System.getenv("AUTOMOBILE_DAEMON_NO_NAVIGATION_SCREENSHOTS")?.trim()?.lowercase().orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withNoNavigationScreenshots(): List<String> {
    if (!noNavigationScreenshotsRequested()) return this
    return this + "--no-navigation-screenshots"
  }

  /**
   * When true, the spawned daemon passes `--no-include-not-important-views` to disable
   * `FLAG_INCLUDE_NOT_IMPORTANT_VIEWS` on the CtrlProxy accessibility service.
   *
   * Configured via JVM system property `automobile.daemon.no.include.not.important.views` or
   * environment variable `AUTOMOBILE_DAEMON_NO_INCLUDE_NOT_IMPORTANT_VIEWS`.
   */
  private fun noIncludeNotImportantViewsRequested(): Boolean {
    if (
      SystemPropertyCache.getBoolean(
        "automobile.daemon.no.include.not.important.views",
        false,
      )
    ) {
      return true
    }
    val env =
      System.getenv("AUTOMOBILE_DAEMON_NO_INCLUDE_NOT_IMPORTANT_VIEWS")
        ?.trim()
        ?.lowercase()
        .orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withNoIncludeNotImportantViews(): List<String> {
    if (!noIncludeNotImportantViewsRequested()) return this
    return this + "--no-include-not-important-views"
  }

  /**
   * When true, the spawned daemon passes `--no-report-view-ids` to disable `FLAG_REPORT_VIEW_IDS`
   * on the CtrlProxy accessibility service.
   *
   * Configured via JVM system property `automobile.daemon.no.report.view.ids` or environment
   * variable `AUTOMOBILE_DAEMON_NO_REPORT_VIEW_IDS`.
   */
  private fun noReportViewIdsRequested(): Boolean {
    if (
      SystemPropertyCache.getBoolean(
        "automobile.daemon.no.report.view.ids",
        false,
      )
    ) {
      return true
    }
    val env = System.getenv("AUTOMOBILE_DAEMON_NO_REPORT_VIEW_IDS")?.trim()?.lowercase().orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withNoReportViewIds(): List<String> {
    if (!noReportViewIdsRequested()) return this
    return this + "--no-report-view-ids"
  }

  /**
   * When true, the spawned daemon passes `--no-retrieve-interactive-windows` to disable
   * `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` on the CtrlProxy accessibility service.
   *
   * Configured via JVM system property `automobile.daemon.no.retrieve.interactive.windows` or
   * environment variable `AUTOMOBILE_DAEMON_NO_RETRIEVE_INTERACTIVE_WINDOWS`.
   */
  private fun noRetrieveInteractiveWindowsRequested(): Boolean {
    if (
      SystemPropertyCache.getBoolean(
        "automobile.daemon.no.retrieve.interactive.windows",
        false,
      )
    ) {
      return true
    }
    val env =
      System.getenv("AUTOMOBILE_DAEMON_NO_RETRIEVE_INTERACTIVE_WINDOWS")
        ?.trim()
        ?.lowercase()
        .orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withNoRetrieveInteractiveWindows(): List<String> {
    if (!noRetrieveInteractiveWindowsRequested()) return this
    return this + "--no-retrieve-interactive-windows"
  }

  /**
   * When true, the spawned daemon passes `--no-waitfor-polling-overhead` to skip screenshots and
   * back stack collection during observe waitFor polling loops. Reduces ADB contention that can
   * cause ctrl-proxy WebSocket instability on resource-constrained CI emulators.
   *
   * Configured via JVM system property `automobile.daemon.no.waitfor.polling.overhead` or
   * environment variable `AUTOMOBILE_DAEMON_NO_WAITFOR_POLLING_OVERHEAD`.
   */
  private fun noWaitForPollingOverheadRequested(): Boolean {
    if (
      SystemPropertyCache.getBoolean(
        "automobile.daemon.no.waitfor.polling.overhead",
        false,
      )
    ) {
      return true
    }
    val env =
      System.getenv("AUTOMOBILE_DAEMON_NO_WAITFOR_POLLING_OVERHEAD")?.trim()?.lowercase().orEmpty()
    return env == "1" || env == "true" || env == "yes"
  }

  private fun List<String>.withNoWaitForPollingOverhead(): List<String> {
    if (!noWaitForPollingOverheadRequested()) return this
    return this + "--no-waitfor-polling-overhead"
  }

  private fun resolveLocalProjectPath(): String? {
    val sysProp = SystemPropertyCache.get("automobile.daemon.local.project.path", "")
    val envVar = System.getenv("AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH")?.trim().orEmpty()
    val path = sysProp.ifEmpty { envVar }
    if (path.isEmpty()) return null
    val dir = File(path)
    return if (dir.isDirectory) dir.absolutePath else null
  }

  private fun resolveRuntimePath(): String {
    // Gradle test workers often have a stripped PATH, so resolve full paths.
    // Prefer bun since the project runs on bun.
    val home = System.getProperty("user.home") ?: System.getenv("HOME") ?: ""
    val candidates =
      listOfNotNull(
        if (home.isNotEmpty()) "$home/.bun/bin/bun" else null,
        "/usr/local/bin/bun",
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        if (home.isNotEmpty()) "$home/.nvm/current/bin/node" else null,
      )

    for (path in candidates) {
      if (File(path).exists()) return path
    }

    return resolveCommandPath("bun") ?: resolveCommandPath("node") ?: "node"
  }

  private fun resolvePackageRunner(): String? {
    for (cmd in listOf("bunx", "npx")) {
      val resolved = resolveCommandPath(cmd)
      if (resolved != null) return resolved
    }
    return null
  }

  private fun resolveCommandPath(cmd: String): String? {
    try {
      val process = ProcessBuilder("which", cmd).redirectErrorStream(true).start()
      val exited = process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
      if (exited && process.exitValue() == 0) {
        val path = process.inputStream.bufferedReader().readText().trim()
        if (path.isNotEmpty()) return path
      }
    } catch (_: Exception) {
      // ignore
    }
    return null
  }

  private fun getUserId(): String {
    val userName = System.getProperty("user.name", "default").ifBlank { "default" }
    val osName = System.getProperty("os.name").lowercase()
    if (osName.contains("win")) {
      return userName
    }

    return try {
      val process = ProcessBuilder("id", "-u").start()
      val exitCode = process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
      if (!exitCode) {
        process.destroy()
        return userName
      }
      val uid = process.inputStream.bufferedReader().readText().trim()
      if (uid.isNotEmpty()) uid else userName
    } catch (e: Exception) {
      userName
    }
  }
}

internal class DaemonSocketClient(
  private val socketPath: String,
  private val clientVersion: String? = DaemonSocketPaths.resolveClientVersion(),
  private val clientBuildId: String? = DaemonSocketPaths.resolveClientBuildId(),
  private val clientEntryScript: String? = DaemonSocketPaths.resolveLocalDaemonEntryScript(),
) : Closeable, DaemonToolClient {
  private val json = Json { ignoreUnknownKeys = true }
  private val pending = ConcurrentHashMap<String, CompletableFuture<DaemonResponse>>()
  private val writeLock = Any()
  @Volatile private var closed = false

  // Session UUID for per-thread plan execution locking.
  // Defaults to a random UUID but can be overridden by autolock session ID from startDevice.
  override var sessionUuid: String = UUID.randomUUID().toString()

  private val channel: SocketChannel = connect()
  private val reader: BufferedReader
  private val writer: BufferedWriter
  private val readThread: Thread

  init {
    val inputStream = Channels.newInputStream(channel)
    val outputStream = Channels.newOutputStream(channel)
    reader = BufferedReader(InputStreamReader(inputStream, StandardCharsets.UTF_8))
    writer = BufferedWriter(OutputStreamWriter(outputStream, StandardCharsets.UTF_8))

    readThread =
      thread(start = true, isDaemon = true, name = "auto-mobile-daemon-reader") { readLoop() }
  }

  fun isConnected(): Boolean {
    return !closed && channel.isOpen
  }

  override fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse {
    if (!isConnected()) {
      throw DaemonUnavailableException("Daemon socket connection is not available")
    }

    val requestId = UUID.randomUUID().toString()
    val request =
      DaemonRequest(
        id = requestId,
        type = "mcp_request",
        method = "tools/call",
        params = buildJsonParams(toolName, arguments),
        timeoutMs = timeoutMs,
        clientVersion = clientVersion,
        clientBuildId = clientBuildId,
        clientEntryScript = clientEntryScript,
      )

    val responseFuture = CompletableFuture<DaemonResponse>()
    pending[requestId] = responseFuture

    sendRequest(request)

    return awaitResponse(requestId, responseFuture, timeoutMs)
  }

  override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
    if (!isConnected()) {
      throw DaemonUnavailableException("Daemon socket connection is not available")
    }

    val requestId = UUID.randomUUID().toString()
    val request =
      DaemonRequest(
        id = requestId,
        type = "mcp_request",
        method = "resources/read",
        params = JsonObject(mapOf("uri" to JsonPrimitive(uri))),
        timeoutMs = timeoutMs,
        clientVersion = clientVersion,
        clientBuildId = clientBuildId,
        clientEntryScript = clientEntryScript,
      )

    val responseFuture = CompletableFuture<DaemonResponse>()
    pending[requestId] = responseFuture

    sendRequest(request)

    return awaitResponse(requestId, responseFuture, timeoutMs)
  }

  fun callDaemonMethod(
    method: String,
    timeoutMs: Long,
    params: JsonObject = JsonObject(emptyMap()),
  ): DaemonResponse {
    if (!isConnected()) {
      throw DaemonUnavailableException("Daemon socket connection is not available")
    }

    val requestId = UUID.randomUUID().toString()
    val request =
      DaemonRequest(
        id = requestId,
        type = "daemon_request",
        method = method,
        params = params,
        clientVersion = clientVersion,
        clientBuildId = clientBuildId,
        clientEntryScript = clientEntryScript,
      )

    val responseFuture = CompletableFuture<DaemonResponse>()
    pending[requestId] = responseFuture

    sendRequest(request)

    return awaitResponse(requestId, responseFuture, timeoutMs)
  }

  /**
   * Await a pending daemon response, translating failure modes into [DaemonUnavailableException] so
   * callers' retry/fallback can catch them, and always removing the pending entry (#3598).
   *
   * `failPendingRequests` completes the future with a [DaemonUnavailableException] when the read
   * loop dies; `future.get` then rethrows it wrapped in an [ExecutionException], so we unwrap it
   * here.
   */
  private fun awaitResponse(
    requestId: String,
    responseFuture: CompletableFuture<DaemonResponse>,
    timeoutMs: Long,
  ): DaemonResponse {
    return try {
      responseFuture.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (e: TimeoutException) {
      throw mapAwaitFailure(e, timeoutMs)
    } catch (e: ExecutionException) {
      throw mapAwaitFailure(e, timeoutMs)
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw mapAwaitFailure(e, timeoutMs)
    } finally {
      pending.remove(requestId)
    }
  }

  override fun close() {
    if (closed) {
      return
    }
    closed = true
    try {
      channel.close()
    } catch (e: Exception) {
      // Ignore close errors
    }
    failPendingRequests("Daemon socket closed")
  }

  private fun connect(): SocketChannel {
    if (!Files.exists(File(socketPath).toPath())) {
      throw DaemonUnavailableException("Daemon socket not found: $socketPath")
    }

    return SocketChannel.open(UnixDomainSocketAddress.of(socketPath))
  }

  private fun sendRequest(request: DaemonRequest) {
    val payload = json.encodeToString(request)
    synchronized(writeLock) {
      writer.write(payload)
      writer.newLine()
      writer.flush()
    }
  }

  private fun readLoop() {
    try {
      while (!closed) {
        val line = reader.readLine() ?: break
        if (line.isBlank()) {
          continue
        }
        try {
          val response = json.decodeFromString(serializer<DaemonResponse>(), line)
          handleResponse(response)
        } catch (e: Exception) {
          println("Failed to parse daemon response: ${e.message}")
        }
      }
    } catch (e: Exception) {
      if (!closed) {
        println("Daemon socket read error: ${e.message}")
      }
    } finally {
      close()
    }
  }

  private fun handleResponse(response: DaemonResponse) {
    val future = pending.remove(response.id)
    if (future != null) {
      future.complete(response)
    }
  }

  private fun buildJsonParams(toolName: String, arguments: JsonObject): JsonObject {
    // Include sessionUuid in tool arguments to enable per-thread plan execution locking
    val argumentsWithSession =
      JsonObject(
        arguments.toMutableMap().apply {
          if (!containsKey("sessionUuid")) {
            put("sessionUuid", JsonPrimitive(sessionUuid))
          }
        }
      )
    return JsonObject(mapOf("name" to JsonPrimitive(toolName), "arguments" to argumentsWithSession))
  }

  private fun failPendingRequests(message: String) {
    val exception = DaemonUnavailableException(message)
    pending.values.forEach { future -> future.completeExceptionally(exception) }
    pending.clear()
  }

  companion object {
    /**
     * Translate a [responseFuture.get] failure into a [DaemonUnavailableException] so callers'
     * retry/fallback (which catch that type) work. A disconnect surfaces as an [ExecutionException]
     * wrapping the [DaemonUnavailableException] that `failPendingRequests` set — unwrap it rather
     * than leaking the opaque wrapper (#3598).
     */
    internal fun mapAwaitFailure(e: Throwable, timeoutMs: Long): DaemonUnavailableException =
      when (e) {
        is TimeoutException ->
          DaemonUnavailableException("Daemon request timeout after ${timeoutMs}ms")
        is ExecutionException -> {
          val cause = e.cause
          (cause as? DaemonUnavailableException)
            ?: DaemonUnavailableException(
              "Daemon request failed: ${cause?.message ?: e.message}",
              cause,
            )
        }
        is InterruptedException -> DaemonUnavailableException("Daemon request interrupted")
        else -> DaemonUnavailableException("Daemon request failed: ${e.message}", e)
      }

    fun isAvailable(socketPath: String): Boolean {
      return try {
        val client = DaemonSocketClient(socketPath)
        client.close()
        true
      } catch (e: Exception) {
        false
      }
    }

    fun waitForAvailability(socketPath: String, timeoutMs: Long): Boolean {
      val start = System.currentTimeMillis()
      while (System.currentTimeMillis() - start < timeoutMs) {
        if (isAvailable(socketPath)) {
          return true
        }
        Thread.sleep(100)
      }
      return false
    }
  }
}

@Serializable
internal data class DaemonRequest(
  val id: String,
  val type: String,
  val method: String,
  val params: JsonObject,
  val timeoutMs: Long? = null,
  // Declared for the daemon's server-side version handshake gate (#2744). Null on
  // legacy runners; the daemon allows those through.
  val clientVersion: String? = null,
  // Build identity (entry-script content hash + path) for the local-override case, so the gate
  // can distinguish two checkouts at the same release version. Null for the package path.
  val clientBuildId: String? = null,
  val clientEntryScript: String? = null,
)

@Serializable
internal data class DaemonResponse(
  val id: String,
  val type: String,
  val success: Boolean,
  val result: JsonElement? = null,
  val error: String? = null,
)

/** Interface for daemon tool calls to enable testing with fakes. */
internal interface DaemonToolClient {
  fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse

  fun readResource(uri: String, timeoutMs: Long): DaemonResponse

  var sessionUuid: String
}

internal class DaemonUnavailableException(message: String, cause: Throwable? = null) :
  Exception(message, cause)

/** Interface for checking daemon connectivity. Allows for easy testing with fakes. */
internal interface DaemonConnectivityChecker {
  fun isDaemonAlive(): Boolean

  fun waitForDaemon(timeoutMs: Long): Boolean
}

/** Default implementation that checks actual daemon socket connectivity. */
internal class DefaultDaemonConnectivityChecker : DaemonConnectivityChecker {
  override fun isDaemonAlive(): Boolean {
    return DaemonSocketClient.isAvailable(DaemonSocketPaths.socketPath())
  }

  override fun waitForDaemon(timeoutMs: Long): Boolean {
    return DaemonSocketClient.waitForAvailability(DaemonSocketPaths.socketPath(), timeoutMs)
  }
}
