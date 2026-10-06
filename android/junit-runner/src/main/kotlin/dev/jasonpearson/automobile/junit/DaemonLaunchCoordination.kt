package dev.jasonpearson.automobile.junit

import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Path
import java.nio.file.StandardOpenOption

/**
 * How a runner JVM treats a daemon it did not start.
 * - [NEVER]: reuse a healthy, matching daemon; start one if absent; restart on build/version skew.
 * - [IF_NEEDED]: the `CI` default. Replace the daemon only when it is absent, unhealthy or of a
 *   different version/build than this runner expects. A healthy, matching daemon is reused even if
 *   this JVM is new, so parallel Gradle forks never stop the daemon under each other's plans
 *   (#10170).
 * - [ALWAYS]: the explicit `automobile.daemon.force.restart=true` opt-in. Unconditionally restarts.
 */
internal enum class DaemonRestartMode {
  NEVER,
  IF_NEEDED,
  ALWAYS,
}

internal enum class DaemonLaunchAction {
  REUSE,
  START,
  RESTART,
}

/**
 * Pure launch decision. [skew] is true only for a running daemon whose version, build or asset
 * version differs from this runner's.
 */
internal fun decideDaemonLaunch(
  mode: DaemonRestartMode,
  daemonAvailable: Boolean,
  skew: Boolean,
): DaemonLaunchAction =
  when {
    mode == DaemonRestartMode.ALWAYS -> DaemonLaunchAction.RESTART
    daemonAvailable && !skew -> DaemonLaunchAction.REUSE
    skew || mode == DaemonRestartMode.IF_NEEDED -> DaemonLaunchAction.RESTART
    else -> DaemonLaunchAction.START
  }

/** Version/build facts that identify a daemon, from its PID file or from this runner. */
internal data class DaemonIdentity(
  val version: String? = null,
  val buildId: String? = null,
  val entryScript: String? = null,
  val assetVersion: String? = null,
)

/** Everything [DaemonLauncher] needs from the outside world, so tests need no socket or process. */
internal interface DaemonLaunchEnvironment {
  val restartMode: DaemonRestartMode
  val startTimeoutMs: Long

  fun isDaemonAvailable(): Boolean

  /** What the running daemon recorded in its PID file. */
  fun daemonIdentity(): DaemonIdentity

  /** What this runner expects; [DaemonIdentity.assetVersion] is the caller's pin. */
  fun runnerIdentity(): DaemonIdentity

  fun runLaunchCommand(restart: Boolean, skewDetected: Boolean)

  fun awaitAvailability(): Boolean
}

/** Serializes a critical section across processes that share the per-user daemon. */
internal interface CrossProcessLock {
  fun <T> withLock(block: () -> T): T
}

/**
 * Ensures the shared daemon is running and matches this runner. The whole check-and-launch runs
 * under a cross-process [lock] and re-reads the daemon's state inside it, so a second runner JVM
 * that waited on the lock finds the daemon the first one just (re)started and reuses it instead of
 * stopping it again (#10170).
 */
internal class DaemonLauncher(
  private val env: DaemonLaunchEnvironment,
  private val lock: CrossProcessLock,
) {
  fun ensureRunning() = lock.withLock { ensureRunningLocked() }

  private fun ensureRunningLocked() {
    val mode = env.restartMode
    val available = env.isDaemonAvailable()
    val skew = detectSkew(available, mode)
    val action = decideDaemonLaunch(mode, available, skew)
    if (action == DaemonLaunchAction.REUSE) return

    env.runLaunchCommand(restart = action == DaemonLaunchAction.RESTART, skewDetected = skew)
    if (!env.awaitAvailability()) {
      throw DaemonUnavailableException("Daemon failed to start within ${env.startTimeoutMs}ms")
    }
    requireMatchingAfterLaunch()

    // NOTE: Device pool initialization check removed to allow parallel test execution.
    // The daemon initializes its device pool at startup, and tests will wait for
    // devices as needed when they call executePlan.
  }

  /**
   * A daemon of a different build already owning the shared per-uid socket would silently serve the
   * wrong tool set (#2744). Compare the identity it recorded in its PID file against this runner's,
   * mirroring the MCP proxy's ensureVersionMatches/ensureBuildMatches. Two checkouts at the same
   * release version are indistinguishable by release alone; the entry-script hash catches them.
   */
  private fun detectSkew(available: Boolean, mode: DaemonRestartMode): Boolean {
    if (!available) return false
    val daemon = env.daemonIdentity()
    val runner = env.runnerIdentity()
    val assetVersionSkew =
      DaemonSocketPaths.requiresAssetVersionPinFailure(daemon.assetVersion, runner.assetVersion)
    val versionSkew = DaemonSocketPaths.requiresVersionSkewRestart(daemon.version, runner.version)
    val buildSkew = hasBuildSkew(daemon, runner)
    if (
      DaemonSocketPaths.requiresImmediateAssetVersionPinFailure(
        assetVersionSkew,
        versionSkew,
        buildSkew,
        mode != DaemonRestartMode.NEVER,
      )
    ) {
      throw DaemonUnavailableException(
        "AutoMobile daemon AUTOMOBILE_VERSION mismatch: the shared daemon was started with " +
          "${daemon.assetVersion ?: "unknown"}, but this runner requested ${runner.assetVersion}. " +
          "Restart the daemon from this runner's environment before reusing it."
      )
    }
    return versionSkew || buildSkew || assetVersionSkew
  }

  private fun hasBuildSkew(daemon: DaemonIdentity, runner: DaemonIdentity): Boolean =
    DaemonSocketPaths.requiresBuildSkewRestart(
      daemon.buildId,
      daemon.entryScript,
      runner.buildId,
      runner.entryScript,
    )

  /**
   * executeCommand returns a CommandResult rather than throwing, and waitForAvailability only
   * confirms socket liveness — a failed versioned bunx/npx restart that leaves the stale socket up,
   * or a PATH `auto-mobile` fallback of a different version, would look "ready" while the daemon's
   * handshake gate (#2744) rejects every request carrying clientVersion/clientBuildId. Confirm the
   * running daemon's version AND build identity match this runner before treating it as ensured; a
   * daemon that records no version/build id is accepted (a skew cannot be proven).
   */
  private fun requireMatchingAfterLaunch() {
    val daemon = env.daemonIdentity()
    val runner = env.runnerIdentity()
    val stillSkewed =
      DaemonSocketPaths.requiresVersionSkewRestart(daemon.version, runner.version) ||
        hasBuildSkew(daemon, runner) ||
        DaemonSocketPaths.requiresAssetVersionPinFailure(daemon.assetVersion, runner.assetVersion)
    if (stillSkewed) {
      throw DaemonUnavailableException(
        "AutoMobile daemon still differs from this runner after (re)start; the shared socket is " +
          "served by a different build. Ensure the same @kaeawc/auto-mobile version starts the " +
          "daemon and runs the tests (e.g. set automobile.daemon.package.version)."
      )
    }
  }
}

/**
 * [CrossProcessLock] backed by an exclusive [FileLock] on [lockFile] (in the daemon's per-user
 * state directory, next to its socket and PID file). Polls `tryLock` so the wait is bounded by
 * [timeoutMs] on the injected clock rather than blocking forever behind a wedged peer. If the lock
 * file cannot be opened at all (read-only state directory) the critical section still runs, without
 * cross-process protection, rather than failing the test run.
 */
internal class FileCrossProcessLock(
  private val lockFile: Path,
  private val timeoutMs: Long,
  private val nowMs: () -> Long = System::currentTimeMillis,
  private val sleep: (Long) -> Unit = { Thread.sleep(it) },
  private val pollMs: Long = LOCK_POLL_MS,
) : CrossProcessLock {
  override fun <T> withLock(block: () -> T): T {
    val channel =
      try {
        FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE)
      } catch (e: IOException) {
        println("Cannot open daemon restart lock $lockFile (${e.message}); continuing without it")
        return block()
      }
    return channel.use {
      val lock = acquire(it)
      try {
        block()
      } finally {
        lock.release()
      }
    }
  }

  private fun acquire(channel: FileChannel): FileLock {
    val deadline = nowMs() + timeoutMs
    while (true) {
      val lock =
        try {
          channel.tryLock()
        } catch (e: OverlappingFileLockException) {
          // This JVM already holds the lock through another channel; treat it as contended.
          null
        }
      if (lock != null) return lock
      if (nowMs() >= deadline) {
        throw DaemonUnavailableException(
          "Timed out after ${timeoutMs}ms waiting for another runner process to finish " +
            "(re)starting the AutoMobile daemon (lock: $lockFile)"
        )
      }
      sleep(pollMs)
    }
  }

  companion object {
    private const val LOCK_POLL_MS = 100L
  }
}

private const val POST_RECOVERY_CONNECT_ATTEMPTS = 3
private const val POST_RECOVERY_BACKOFF_MS = 100L

/**
 * Connects to the daemon, treating a refused/missing socket as "daemon not running" (#10169): a
 * daemon that dies without unlinking its socket leaves a file behind that [connect] cannot use.
 * After the first failure, [recover] (clear the cached client, run the ensure-running path once) is
 * invoked, then the connect is retried a bounded number of times with [sleep] between attempts. A
 * daemon that is still unreachable surfaces as a [DaemonUnavailableException] naming [socketPath],
 * never a raw [java.net.ConnectException]. This never removes a socket file: the daemon's own
 * launcher decides whether the incumbent is live.
 */
internal fun <T : Any> connectWithDaemonRecovery(
  socketPath: String,
  connect: () -> T,
  sleep: (Long) -> Unit,
  recover: () -> Unit,
): T {
  var lastFailure: Exception? = null
  connectOrNull(connect) { lastFailure = it }
    ?.let {
      return it
    }
  recover()
  for (attempt in 1..POST_RECOVERY_CONNECT_ATTEMPTS) {
    connectOrNull(connect) { lastFailure = it }
      ?.let {
        return it
      }
    if (attempt < POST_RECOVERY_CONNECT_ATTEMPTS) sleep(POST_RECOVERY_BACKOFF_MS * attempt)
  }
  throw DaemonUnavailableException(
    "AutoMobile daemon is not reachable at $socketPath even after attempting to restart it: " +
      "${lastFailure?.message}",
    lastFailure,
  )
}

private fun <T : Any> connectOrNull(connect: () -> T, onFailure: (Exception) -> Unit): T? =
  try {
    connect()
  } catch (e: IOException) {
    onFailure(e)
    null
  } catch (e: DaemonUnavailableException) {
    onFailure(e)
    null
  }
