package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.lang.management.ManagementFactory
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Paths
import java.nio.file.StandardOpenOption

/**
 * Opens a per-thread daemon connection, (re)starting the shared daemon first when needed.
 *
 * The daemon is ensured once per JVM, and again whenever its socket file is gone. A daemon that
 * dies without unlinking its socket (SIGKILL, the OOM killer, a crash) leaves the file behind, so a
 * connect failure on an already-ensured daemon also re-runs [ensureDaemon] once and retries the
 * connect. A second failure surfaces as a [DaemonUnavailableException] so the plan executor's
 * existing retry and failure reporting apply instead of a raw "Connection refused" (#10169).
 */
internal class DaemonConnectionProvider<C>(
  private val socketExists: () -> Boolean,
  private val ensureDaemon: () -> Unit,
  private val connect: () -> C,
) {
  private val lock = Any()
  private var daemonEnsured = false
  // Bumped on every successful ensure, so threads that saw the same dead daemon re-ensure it once.
  private var ensureGeneration = 0L

  fun open(): C {
    val generation =
      synchronized(lock) {
        if (!socketExists()) {
          daemonEnsured = false
        }
        if (!daemonEnsured) {
          ensureLocked()
        }
        ensureGeneration
      }
    return try {
      connect()
    } catch (e: DaemonUnavailableException) {
      reconnect(generation, e)
    } catch (e: IOException) {
      reconnect(generation, e)
    }
  }

  private fun reconnect(failedGeneration: Long, firstFailure: Exception): C {
    synchronized(lock) {
      if (ensureGeneration == failedGeneration) {
        daemonEnsured = false
        ensureLocked()
      }
    }
    return try {
      connect()
    } catch (e: DaemonUnavailableException) {
      throw e
    } catch (e: IOException) {
      throw DaemonUnavailableException(
        "AutoMobile daemon is not accepting connections after restart: ${e.message} " +
          "(first failure: ${firstFailure.message})",
        e,
      )
    }
  }

  private fun ensureLocked() {
    ensureDaemon()
    daemonEnsured = true
    ensureGeneration++
  }
}

/** Identity fields the daemon records in its PID file. Null when absent or unreadable. */
internal data class DaemonPidRecord(
  val version: String? = null,
  val assetVersion: String? = null,
  val buildId: String? = null,
  val entryScript: String? = null,
  val startedAtMs: Long? = null,
)

/** This runner's identity, compared against [DaemonPidRecord] to detect a wrong-build daemon. */
internal data class DaemonClientIdentity(
  val version: String? = null,
  val buildId: String? = null,
  val entryScript: String? = null,
  val assetVersionPin: String? = null,
)

/** Everything [DaemonLauncher] reads or does outside its own decision logic. */
internal interface DaemonLaunchEnvironment {
  /** Whether configuration asks for a forced restart (explicit flag, or `CI`). */
  val forceRestartRequested: Boolean

  /** When this runner JVM started (epoch ms), or null when unknown. */
  val runnerStartedAtMs: Long?

  val startTimeoutMs: Long

  val clientIdentity: DaemonClientIdentity

  fun isDaemonAvailable(): Boolean

  fun readPidRecord(): DaemonPidRecord

  /** Run the daemon `restart` (when [restart]) or `start` command. */
  fun launch(restart: Boolean)

  fun waitForDaemon(timeoutMs: Long): Boolean

  /** Run [block] while holding the lock shared by every runner JVM of this user. */
  fun <T> withRunnerRestartLock(block: () -> T): T

  fun debugLog(message: String)
}

internal object DaemonLauncher {
  /**
   * Make sure a daemon of this runner's build is serving the shared socket.
   *
   * The check-and-restart runs under a cross-process lock, and a requested forced restart is
   * skipped when the running daemon started after this runner JVM: another runner of the same run
   * (a parallel Gradle fork) already replaced the stale daemon, and stopping it again would fail
   * that runner's in-flight plans (#10170). The version, build and asset-version skew checks are
   * unchanged.
   */
  fun ensureRunning(env: DaemonLaunchEnvironment) {
    env.withRunnerRestartLock { ensureRunningLocked(env) }
  }

  private fun ensureRunningLocked(env: DaemonLaunchEnvironment) {
    val identity = env.clientIdentity
    val forceRestartRequested = env.forceRestartRequested
    val daemonAvailable = env.isDaemonAvailable()
    val record = env.readPidRecord()

    // A daemon of a different build already owning the shared per-uid socket would silently serve
    // the wrong tool set (#2744). Before reusing it, compare the version, build identity and asset
    // version it recorded in its PID file against this runner's and restart on skew, mirroring the
    // MCP proxy's ensureVersionMatches/ensureBuildMatches.
    val assetVersionSkew =
      daemonAvailable &&
        DaemonSocketPaths.requiresAssetVersionPinFailure(
          record.assetVersion,
          identity.assetVersionPin,
        )
    val versionSkew =
      daemonAvailable &&
        DaemonSocketPaths.requiresVersionSkewRestart(record.version, identity.version)
    // Two checkouts at the same release version (e.g. a stale `0.0.40+gold` daemon vs this local
    // `0.0.40`) are indistinguishable by release alone; the entry-script hash catches them.
    val buildSkew =
      daemonAvailable &&
        DaemonSocketPaths.requiresBuildSkewRestart(
          record.buildId,
          record.entryScript,
          identity.buildId,
          identity.entryScript,
        )
    if (
      DaemonSocketPaths.requiresImmediateAssetVersionPinFailure(
        assetVersionSkew,
        versionSkew,
        buildSkew,
        forceRestartRequested,
      )
    ) {
      throw DaemonUnavailableException(
        "AutoMobile daemon AUTOMOBILE_VERSION mismatch: the shared daemon was started with " +
          "${record.assetVersion ?: "unknown"}, but this runner requested " +
          "${identity.assetVersionPin}. Restart the daemon from this runner's environment " +
          "before reusing it."
      )
    }
    val skew = versionSkew || buildSkew || assetVersionSkew
    val forcedRestart =
      DaemonSocketPaths.requiresForcedRestart(
        forceRestartRequested,
        daemonAvailable,
        record.startedAtMs,
        env.runnerStartedAtMs,
      )
    if (forceRestartRequested && !forcedRestart && daemonAvailable) {
      env.debugLog(
        "Reusing AutoMobile daemon started after this runner (another runner of this run " +
          "already restarted it)"
      )
    }

    if (!forcedRestart && daemonAvailable && !skew) {
      return
    }

    if (skew) {
      env.debugLog("Restarting AutoMobile daemon due to version/build skew with runner")
    }
    env.launch(restart = forcedRestart || skew)

    if (!env.waitForDaemon(env.startTimeoutMs)) {
      throw DaemonUnavailableException("Daemon failed to start within ${env.startTimeoutMs}ms")
    }

    // The launch command reports failure as a result rather than throwing, and waitForDaemon only
    // confirms socket liveness: a failed versioned bunx/npx restart that leaves the stale socket
    // up, or a PATH `auto-mobile` fallback of a different version, would look "ready" while the
    // daemon's handshake gate (#2744) rejects every request carrying clientVersion/clientBuildId.
    // Confirm the running daemon's version AND build identity match this runner; a daemon that
    // records no version/build id is accepted (a skew cannot be proven).
    val started = env.readPidRecord()
    val stillSkewed =
      DaemonSocketPaths.requiresVersionSkewRestart(started.version, identity.version) ||
        DaemonSocketPaths.requiresBuildSkewRestart(
          started.buildId,
          started.entryScript,
          identity.buildId,
          identity.entryScript,
        ) ||
        DaemonSocketPaths.requiresAssetVersionPinFailure(
          started.assetVersion,
          identity.assetVersionPin,
        )
    if (stillSkewed) {
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
}

/** Production wiring for [DaemonLauncher]: real socket, PID file, launcher command and lock. */
internal class DefaultDaemonLaunchEnvironment(
  private val environmentOverrides: Map<String, String>
) : DaemonLaunchEnvironment {
  private val socketPath = DaemonSocketPaths.socketPath()
  private val pidFilePath = DaemonSocketPaths.pidFilePath()
  private val debugMode = SystemPropertyCache.getBoolean("automobile.debug", false)

  override val forceRestartRequested: Boolean = DaemonSocketPaths.resolveForceRestart()

  override val runnerStartedAtMs: Long? = runnerJvmStartedAtMs()

  override val startTimeoutMs: Long = DaemonSocketPaths.daemonStartTimeoutMs()

  override val clientIdentity: DaemonClientIdentity
    get() =
      DaemonClientIdentity(
        version = DaemonSocketPaths.resolveClientVersion(),
        buildId = DaemonSocketPaths.resolveClientBuildId(),
        entryScript = DaemonSocketPaths.resolveLocalDaemonEntryScript(),
        assetVersionPin = DaemonSocketPaths.resolveCallerAssetVersionPin(),
      )

  override fun isDaemonAvailable(): Boolean = DaemonSocketClient.isAvailable(socketPath)

  override fun readPidRecord(): DaemonPidRecord =
    DaemonPidRecord(
      version = DaemonSocketPaths.readDaemonVersionFromPidFile(pidFilePath),
      assetVersion = DaemonSocketPaths.readDaemonAssetVersionFromPidFile(pidFilePath),
      buildId = DaemonSocketPaths.readDaemonBuildIdFromPidFile(pidFilePath),
      entryScript = DaemonSocketPaths.readDaemonEntryScriptFromPidFile(pidFilePath),
      startedAtMs = DaemonSocketPaths.readDaemonStartedAtMsFromPidFile(pidFilePath),
    )

  override fun launch(restart: Boolean) {
    val command =
      if (restart) {
        DaemonSocketPaths.buildDaemonRestartCommand()
      } else {
        DaemonSocketPaths.buildDaemonStartCommand()
      }
    debugLog("Starting AutoMobile daemon with: ${command.joinToString(" ")}")
    AutoMobileSharedUtils.executeCommand(
      command,
      DaemonSocketPaths.daemonLauncherTimeoutMs(isRestart = restart),
      environmentOverrides,
    )
  }

  override fun waitForDaemon(timeoutMs: Long): Boolean =
    DaemonSocketClient.waitForAvailability(socketPath, timeoutMs)

  override fun <T> withRunnerRestartLock(block: () -> T): T =
    withCrossProcessFileLock(
      DaemonSocketPaths.runnerRestartLockPath(),
      onLockUnavailable = { e ->
        println("AutoMobile runner restart lock unavailable, continuing unlocked: ${e.message}")
      },
      block = block,
    )

  override fun debugLog(message: String) {
    if (debugMode) {
      println(message)
    }
  }

  private fun runnerJvmStartedAtMs(): Long? =
    try {
      ManagementFactory.getRuntimeMXBean().startTime.takeIf { it > 0 }
    } catch (e: SecurityException) {
      // Without a start time the forced restart is kept (today's behaviour), so this is safe.
      debugLog("Runner JVM start time unavailable: ${e.message}")
      null
    }
}

/**
 * Run [block] while holding an exclusive [FileChannel.lock] on [path], which serializes it across
 * processes. When the lock cannot be taken (unwritable path, or this JVM already holds it on
 * another channel) [onLockUnavailable] is told and [block] runs unlocked: the lock only narrows a
 * race between runner JVMs, so failing the test run over it would be worse.
 */
internal fun <T> withCrossProcessFileLock(
  path: String,
  onLockUnavailable: (Exception) -> Unit,
  block: () -> T,
): T {
  val channel =
    try {
      File(path).parentFile?.mkdirs()
      FileChannel.open(Paths.get(path), StandardOpenOption.CREATE, StandardOpenOption.WRITE)
    } catch (e: IOException) {
      onLockUnavailable(e)
      return block()
    }
  return channel.use {
    val lock = acquireFileLock(it, onLockUnavailable)
    try {
      block()
    } finally {
      lock?.release()
    }
  }
}

private fun acquireFileLock(
  channel: FileChannel,
  onLockUnavailable: (Exception) -> Unit,
): FileLock? =
  try {
    channel.lock()
  } catch (e: IOException) {
    onLockUnavailable(e)
    null
  } catch (e: OverlappingFileLockException) {
    onLockUnavailable(e)
    null
  }
