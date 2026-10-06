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
 * - [IF_NEEDED]: the `CI` default. Replace the daemon when it is absent, unhealthy, of a different
 *   version/build than this runner expects, or STALE FOR THE RUN: started before this test run
 *   began (a leftover from an earlier job or retry attempt) or launched with different flags than
 *   this runner would pass (see [isDaemonStaleForRun]). Every fork of one run shares the run's
 *   start marker, so the first fork replaces a leftover daemon exactly once and the others reuse
 *   it; they never stop it under each other's plans (#10170). Without a run marker (an IDE
 *   launching a test directly) only the absent/unhealthy/skew checks apply and a healthy matching
 *   daemon is reused.
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
 * version differs from this runner's. [staleForRun] (see [isDaemonStaleForRun]) restarts a healthy,
 * matching daemon only under [DaemonRestartMode.IF_NEEDED]; [DaemonRestartMode.NEVER] keeps reusing
 * it.
 */
internal fun decideDaemonLaunch(
  mode: DaemonRestartMode,
  daemonAvailable: Boolean,
  skew: Boolean,
  staleForRun: Boolean = false,
): DaemonLaunchAction =
  when {
    mode == DaemonRestartMode.ALWAYS -> DaemonLaunchAction.RESTART
    daemonAvailable && !skew && !(staleForRun && mode == DaemonRestartMode.IF_NEEDED) ->
      DaemonLaunchAction.REUSE
    skew || mode == DaemonRestartMode.IF_NEEDED -> DaemonLaunchAction.RESTART
    else -> DaemonLaunchAction.START
  }

/**
 * Facts that identify a daemon, from its PID file or from this runner. [startedAtMs] is the PID
 * record's `startedAt` (epoch ms; null when absent). [launchFlags] are the [DAEMON_LAUNCH_FLAGS]
 * option keys that are on: for a daemon, those its PID record's `options` has set (null when the
 * record carries no `options`, i.e. unknown); for the runner, those it would pass when launching.
 */
internal data class DaemonIdentity(
  val version: String? = null,
  val buildId: String? = null,
  val entryScript: String? = null,
  val assetVersion: String? = null,
  val startedAtMs: Long? = null,
  val launchFlags: Set<String>? = null,
)

/**
 * The launch flags the runner may append (`DaemonSocketPaths.buildDaemonCommand`) mapped to the
 * `DaemonOptions` key the daemon records them under in its PID file (`options`). Only these are
 * compared; `AUTOMOBILE_CTRL_PROXY_APK_PATH` is NOT recorded by the daemon, so a different APK path
 * is covered only by the once-per-run restart ([isDaemonStaleForRun] rule 1).
 */
internal val DAEMON_LAUNCH_FLAGS: Map<String, String> =
  mapOf(
    "--dismiss-keyboard-after-input" to "dismissKeyboardAfterInput",
    "--no-ui-perf-mode" to "noUiPerfMode",
    "--no-navigation-screenshots" to "noNavigationScreenshots",
    "--no-waitfor-polling-overhead" to "noWaitForPollingOverhead",
    "--no-include-not-important-views" to "noA11yIncludeNotImportantViews",
    "--no-report-view-ids" to "noA11yReportViewIds",
    "--no-retrieve-interactive-windows" to "noA11yRetrieveInteractiveWindows",
  )

/**
 * Whether a healthy, version-matching [daemon] must still be replaced for this run (#10170):
 * 1. it started before the run began (`startedAtMs < runStartedAtMs`): a leftover from an earlier
 *    job or retry attempt, replaced once because the restart itself starts after the run marker;
 * 2. it was launched with different flags than the [runner] would pass. Both rules need the run
 *    marker: without [runStartedAtMs] (an IDE launching a test directly) a developer's resident
 *    daemon is never replaced for being old or differently configured. Other unknown facts never
 *    prove staleness either: no recorded start time or no recorded options leaves that rule out.
 */
internal fun isDaemonStaleForRun(
  daemon: DaemonIdentity,
  runner: DaemonIdentity,
  runStartedAtMs: Long?,
): Boolean {
  if (runStartedAtMs == null) return false
  val startedAt = daemon.startedAtMs
  val startedBeforeRun = startedAt != null && startedAt < runStartedAtMs
  val daemonFlags = daemon.launchFlags
  val flagsDiffer = daemonFlags != null && daemonFlags != (runner.launchFlags ?: emptySet<String>())
  return startedBeforeRun || flagsDiffer
}

/** Everything [DaemonLauncher] needs from the outside world, so tests need no socket or process. */
internal interface DaemonLaunchEnvironment {
  val restartMode: DaemonRestartMode
  val startTimeoutMs: Long

  /**
   * When this test run began (epoch ms), shared by every fork of one Gradle test task; null when
   * the run has no marker (see [isDaemonStaleForRun]).
   */
  val runStartedAtMs: Long?

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
    val stale = available && !skew && mode == DaemonRestartMode.IF_NEEDED && isStaleForRun()
    val action = decideDaemonLaunch(mode, available, skew, stale)
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

  private fun isStaleForRun(): Boolean =
    isDaemonStaleForRun(env.daemonIdentity(), env.runnerIdentity(), env.runStartedAtMs)

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
 * cross-process protection, rather than failing the test run; that degraded mode is reported
 * through [warn] (the module has no logging framework, so a warning on stderr by default) naming
 * the lock path, because two forks that both find no daemon can then each restart it (#10170). A
 * lock that opens but cannot be taken (`tryLock` throws [IOException]) fails with a
 * [DaemonUnavailableException], the same typed failure as a timeout.
 */
internal class FileCrossProcessLock(
  private val lockFile: Path,
  private val timeoutMs: Long,
  private val nowMs: () -> Long = System::currentTimeMillis,
  private val sleep: (Long) -> Unit = { Thread.sleep(it) },
  private val pollMs: Long = LOCK_POLL_MS,
  private val warn: (String) -> Unit = { System.err.println(it) },
  private val tryLock: (FileChannel) -> FileLock? = { it.tryLock() },
) : CrossProcessLock {
  override fun <T> withLock(block: () -> T): T {
    val channel =
      try {
        FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE)
      } catch (e: IOException) {
        warn(
          "WARN: cannot open the daemon restart lock $lockFile (${e.message}); continuing " +
            "WITHOUT cross-process locking, so parallel runners may restart the daemon twice"
        )
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
          tryLock(channel)
        } catch (e: OverlappingFileLockException) {
          // This JVM already holds the lock through another channel; treat it as contended.
          null
        } catch (e: IOException) {
          throw DaemonUnavailableException(
            "Cannot take the daemon restart lock $lockFile: ${e.message}",
            e,
          )
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

/**
 * Tail of the [DaemonUnavailableException] message [connectWithDaemonRecovery] raises. The plan
 * executor reads it back as "never reached the daemon" (safe to retry), so both sides share it.
 */
internal const val DAEMON_UNREACHABLE_AFTER_RESTART = "even after attempting to restart it"

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
    "AutoMobile daemon is not reachable at $socketPath $DAEMON_UNREACHABLE_AFTER_RESTART: " +
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
