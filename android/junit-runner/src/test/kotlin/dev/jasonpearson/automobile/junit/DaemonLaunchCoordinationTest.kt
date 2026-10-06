package dev.jasonpearson.automobile.junit

import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * A forced restart must not stop a healthy, version-compatible daemon just because this JVM is new
 * (#10170): parallel Gradle forks share one per-user daemon.
 */
class DaemonLaunchCoordinationTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  @Test
  fun launchDecisionTable() {
    val never = DaemonRestartMode.NEVER
    val ifNeeded = DaemonRestartMode.IF_NEEDED
    val always = DaemonRestartMode.ALWAYS
    val reuse = DaemonLaunchAction.REUSE
    val start = DaemonLaunchAction.START
    val restart = DaemonLaunchAction.RESTART
    // mode, daemonAvailable, skew, staleForRun -> action
    data class Row(
      val mode: DaemonRestartMode,
      val available: Boolean,
      val skew: Boolean,
      val stale: Boolean,
    )
    val table =
      listOf(
        Row(never, true, false, false) to reuse,
        Row(never, true, true, false) to restart,
        Row(never, false, false, false) to start,
        // NEVER keeps reusing a healthy matching daemon however old it is.
        Row(never, true, false, true) to reuse,
        Row(never, false, false, true) to start,
        Row(ifNeeded, true, false, false) to reuse,
        Row(ifNeeded, true, true, false) to restart,
        Row(ifNeeded, false, false, false) to restart,
        // IF_NEEDED replaces a daemon that is stale for this run, and only then.
        Row(ifNeeded, true, false, true) to restart,
        Row(ifNeeded, true, true, true) to restart,
        Row(ifNeeded, false, false, true) to restart,
        Row(always, true, false, false) to restart,
        Row(always, true, true, false) to restart,
        Row(always, false, false, false) to restart,
        Row(always, true, false, true) to restart,
      )
    for ((row, expected) in table) {
      assertEquals(
        expected,
        decideDaemonLaunch(row.mode, row.available, row.skew, row.stale),
        "$row",
      )
    }
  }

  @Test
  fun staleForRunTable() {
    val runner = DaemonIdentity(launchFlags = setOf("noUiPerfMode"))
    val sameFlags = setOf("noUiPerfMode")
    // daemon, runStartedAtMs -> stale
    val table =
      listOf(
        // Started before the run: leftover from an earlier job or retry attempt.
        Triple(DaemonIdentity(startedAtMs = 999L, launchFlags = sameFlags), 1_000L, true),
        // Started at or after the run began: another fork of this run brought it up.
        Triple(DaemonIdentity(startedAtMs = 1_000L, launchFlags = sameFlags), 1_000L, false),
        Triple(DaemonIdentity(startedAtMs = 5_000L, launchFlags = sameFlags), 1_000L, false),
        // Launched with different flags (extra, missing or swapped).
        Triple(DaemonIdentity(startedAtMs = 5_000L, launchFlags = emptySet()), 1_000L, true),
        Triple(
          DaemonIdentity(startedAtMs = 5_000L, launchFlags = sameFlags + "noNavigationScreenshots"),
          1_000L,
          true,
        ),
        // Unknown facts never prove staleness.
        Triple(DaemonIdentity(startedAtMs = null, launchFlags = sameFlags), 1_000L, false),
        Triple(DaemonIdentity(startedAtMs = 5_000L, launchFlags = null), 1_000L, false),
        // No run marker (an IDE launch): a developer's daemon is never replaced for age or flags.
        Triple(DaemonIdentity(startedAtMs = 1L, launchFlags = emptySet()), null, false),
      )
    for ((daemon, runStartedAtMs, expected) in table) {
      assertEquals(
        expected,
        isDaemonStaleForRun(daemon, runner, runStartedAtMs),
        "daemon=$daemon run=$runStartedAtMs",
      )
    }
  }

  @Test
  fun leftoverDaemonFromBeforeTheRunIsReplacedOnceAcrossForks() {
    val env =
      FakeLaunchEnvironment(
        DaemonRestartMode.IF_NEEDED,
        available = true,
        daemon = DaemonIdentity(version = "0.0.40", startedAtMs = 500L),
        runStartedAtMs = 1_000L,
      )
    val lock = RecordingLock()

    // Fork A finds the leftover and replaces it; fork B re-reads the state under the lock, sees a
    // daemon that started after the run marker and reuses it.
    DaemonLauncher(env, lock).ensureRunning()
    DaemonLauncher(env, lock).ensureRunning()
    DaemonLauncher(env, lock).ensureRunning()

    assertEquals(listOf("restart"), env.commands)
  }

  @Test
  fun daemonLaunchedWithDifferentFlagsIsReplacedUnderCi() {
    val env =
      FakeLaunchEnvironment(
        DaemonRestartMode.IF_NEEDED,
        available = true,
        daemon = DaemonIdentity(version = "0.0.40", startedAtMs = 5_000L, launchFlags = emptySet()),
        runner = DaemonIdentity(version = "0.0.40", launchFlags = setOf("noUiPerfMode")),
        runStartedAtMs = 1_000L,
      )

    DaemonLauncher(env, RecordingLock()).ensureRunning()

    assertEquals(listOf("restart"), env.commands)
  }

  @Test
  fun leftoverDaemonIsReusedWithoutARunMarkerOrOutsideCi() {
    val leftover = DaemonIdentity(version = "0.0.40", startedAtMs = 1L, launchFlags = emptySet())
    val runner = DaemonIdentity(version = "0.0.40", launchFlags = setOf("noUiPerfMode"))
    val noMarker =
      FakeLaunchEnvironment(
        DaemonRestartMode.IF_NEEDED,
        available = true,
        daemon = leftover,
        runner = runner,
        runStartedAtMs = null,
      )
    val local =
      FakeLaunchEnvironment(
        DaemonRestartMode.NEVER,
        available = true,
        daemon = leftover,
        runner = runner,
        runStartedAtMs = 1_000L,
      )

    DaemonLauncher(noMarker, RecordingLock()).ensureRunning()
    DaemonLauncher(local, RecordingLock()).ensureRunning()

    assertEquals(emptyList(), noMarker.commands)
    assertEquals(emptyList(), local.commands)
  }

  @Test
  fun pidFileRecordsStartTimeAndLaunchFlags() {
    val pidFile = temporaryFolder.newFile("daemon.pid")
    pidFile.writeText(
      """{"pid":1,"startedAt":1700000000123,"version":"0.0.40",
        "options":{"noUiPerfMode":true,"dismissKeyboardAfterInput":false,"debug":true}}"""
    )

    assertEquals(1700000000123L, DaemonSocketPaths.readDaemonStartedAtFromPidFile(pidFile.path))
    assertEquals(
      setOf("noUiPerfMode"),
      DaemonSocketPaths.readDaemonLaunchFlagsFromPidFile(pidFile.path),
    )
  }

  @Test
  fun pidFileWithoutOptionsOrStartTimeReportsUnknownNotEmpty() {
    val pidFile = temporaryFolder.newFile("old.pid")
    pidFile.writeText("""{"pid":1,"version":"0.0.30"}""")

    assertEquals(null, DaemonSocketPaths.readDaemonStartedAtFromPidFile(pidFile.path))
    assertEquals(null, DaemonSocketPaths.readDaemonLaunchFlagsFromPidFile(pidFile.path))
    val missing = temporaryFolder.root.resolve("absent.pid").path
    assertEquals(null, DaemonSocketPaths.readDaemonStartedAtFromPidFile(missing))
    assertEquals(null, DaemonSocketPaths.readDaemonLaunchFlagsFromPidFile(missing))
  }

  @Test
  fun restartModeResolution() {
    fun resolve(property: String?, env: String?, ci: String?) =
      DaemonSocketPaths.resolveRestartMode(property, env, ci)
    assertEquals(DaemonRestartMode.NEVER, resolve(null, null, null))
    assertEquals(DaemonRestartMode.NEVER, resolve("", "", ""))
    assertEquals(DaemonRestartMode.IF_NEEDED, resolve(null, null, "true"))
    assertEquals(DaemonRestartMode.IF_NEEDED, resolve(null, null, "1"))
    assertEquals(DaemonRestartMode.ALWAYS, resolve("true", null, "false"))
    assertEquals(DaemonRestartMode.ALWAYS, resolve(null, "yes", null))
    assertEquals(DaemonRestartMode.NEVER, resolve("false", null, "true"))
    assertEquals(DaemonRestartMode.NEVER, resolve(null, "no", "true"))
  }

  @Test
  fun ciDefaultReusesAHealthyMatchingDaemon() {
    val env = FakeLaunchEnvironment(DaemonRestartMode.IF_NEEDED, available = true)

    DaemonLauncher(env, RecordingLock()).ensureRunning()

    assertEquals(emptyList(), env.commands)
  }

  @Test
  fun twoForksAgainstTheSameFreshDaemonIssueOneRestart() {
    val env = FakeLaunchEnvironment(DaemonRestartMode.IF_NEEDED, available = false)
    val lock = RecordingLock()

    // Fork A finds no daemon and restarts it; fork B then waits on the lock, re-reads the state
    // inside it and finds the daemon A brought up.
    DaemonLauncher(env, lock).ensureRunning()
    DaemonLauncher(env, lock).ensureRunning()

    assertEquals(listOf("restart"), env.commands)
    assertEquals(2, lock.entries)
  }

  @Test
  fun unhealthyOrAbsentDaemonIsRestartedUnderCi() {
    val env = FakeLaunchEnvironment(DaemonRestartMode.IF_NEEDED, available = false)

    DaemonLauncher(env, RecordingLock()).ensureRunning()

    assertEquals(listOf("restart"), env.commands)
  }

  @Test
  fun versionOrBuildSkewIsRestartedUnderCi() {
    val skewedDaemons =
      listOf(
        DaemonIdentity(version = "0.0.39"),
        DaemonIdentity(version = "0.0.40", buildId = "aaaa", entryScript = "/old/index.js"),
      )
    for (daemon in skewedDaemons) {
      val env =
        FakeLaunchEnvironment(
          DaemonRestartMode.IF_NEEDED,
          available = true,
          daemon = daemon,
          runner =
            DaemonIdentity(version = "0.0.40", buildId = "bbbb", entryScript = "/new/index.js"),
        )

      DaemonLauncher(env, RecordingLock()).ensureRunning()

      assertEquals(listOf("restart"), env.commands, "daemon=$daemon")
    }
  }

  @Test
  fun explicitOptInStillRestartsAHealthyDaemon() {
    val env = FakeLaunchEnvironment(DaemonRestartMode.ALWAYS, available = true)

    DaemonLauncher(env, RecordingLock()).ensureRunning()

    assertEquals(listOf("restart"), env.commands)
  }

  @Test
  fun withoutForceAnAbsentDaemonIsStartedNotRestarted() {
    val env = FakeLaunchEnvironment(DaemonRestartMode.NEVER, available = false)

    DaemonLauncher(env, RecordingLock()).ensureRunning()

    assertEquals(listOf("start"), env.commands)
  }

  @Test
  fun assetVersionOnlySkewFailsFastWithoutForceAndRestartsWithIt() {
    val daemon = DaemonIdentity(assetVersion = "1.0.0")
    val runner = DaemonIdentity(assetVersion = "2.0.0")

    val strict = FakeLaunchEnvironment(DaemonRestartMode.NEVER, true, daemon, runner)
    assertFailsWith<DaemonUnavailableException> {
      DaemonLauncher(strict, RecordingLock()).ensureRunning()
    }
    assertEquals(emptyList(), strict.commands)

    val ci = FakeLaunchEnvironment(DaemonRestartMode.IF_NEEDED, true, daemon, runner)
    DaemonLauncher(ci, RecordingLock()).ensureRunning()
    assertEquals(listOf("restart"), ci.commands)
  }

  @Test
  fun daemonThatNeverBecomesAvailableFailsWithTheStartTimeout() {
    val env =
      FakeLaunchEnvironment(DaemonRestartMode.IF_NEEDED, available = false, launchSucceeds = false)

    val error =
      assertFailsWith<DaemonUnavailableException> {
        DaemonLauncher(env, RecordingLock()).ensureRunning()
      }

    assertTrue(error.message.orEmpty().contains("failed to start within 30000ms"))
  }

  @Test
  fun relaunchThatLeavesADifferentBuildServingTheSocketFails() {
    val env =
      FakeLaunchEnvironment(
        DaemonRestartMode.ALWAYS,
        available = true,
        daemon = DaemonIdentity(version = "0.0.39"),
        runner = DaemonIdentity(version = "0.0.40"),
        launchLeavesDaemonUnchanged = true,
      )

    val error =
      assertFailsWith<DaemonUnavailableException> {
        DaemonLauncher(env, RecordingLock()).ensureRunning()
      }

    assertTrue(error.message.orEmpty().contains("still differs from this runner"))
  }

  @Test
  fun fileLockSerializesHoldersAndTimesOutOnInjectedClock() {
    val lockFile = temporaryFolder.root.toPath().resolve("restart.lock")
    var now = 0L
    val sleeps = mutableListOf<Long>()
    fun newLock(): FileCrossProcessLock =
      FileCrossProcessLock(
        lockFile,
        timeoutMs = 250L,
        nowMs = { now },
        sleep = {
          sleeps.add(it)
          now += it
        },
        pollMs = 100L,
      )

    val outcome =
      newLock().withLock {
        // A second holder (same JVM, so an overlapping lock) cannot enter and gives up on the
        // injected clock without a real sleep.
        val contender = assertFailsWith<DaemonUnavailableException> { newLock().withLock { "no" } }
        assertTrue(contender.message.orEmpty().contains("restart.lock"))
        "held"
      }

    assertEquals("held", outcome)
    assertEquals(listOf(100L, 100L, 100L), sleeps)
    // Released: the next holder enters immediately.
    assertEquals("again", newLock().withLock { "again" })
  }

  @Test
  fun unopenableLockFileStillRunsTheSection() {
    val missingDirectory: Path = temporaryFolder.root.toPath().resolve("no/such/dir/restart.lock")

    val warnings = mutableListOf<String>()

    val result =
      FileCrossProcessLock(missingDirectory, timeoutMs = 1L, warn = { warnings.add(it) }).withLock {
        "ran"
      }

    assertEquals("ran", result)
    // The degraded, unlocked mode is announced and names the lock path.
    val warning = warnings.single()
    assertTrue(warning.startsWith("WARN"), warning)
    assertTrue(warning.contains(missingDirectory.toString()), warning)
  }

  @Test
  fun ioFailureTakingTheLockIsTheTypedUnavailableFailure() {
    val lockFile = temporaryFolder.root.toPath().resolve("restart.lock")
    var entered = false
    val lock =
      FileCrossProcessLock(
        lockFile,
        timeoutMs = 250L,
        tryLock = { throw java.io.IOException("lock not supported on this filesystem") },
      )

    val error = assertFailsWith<DaemonUnavailableException> { lock.withLock { entered = true } }

    assertTrue(error.message.orEmpty().contains("restart.lock"))
    assertTrue(error.message.orEmpty().contains("lock not supported"))
    assertTrue(error.cause is java.io.IOException)
    assertEquals(false, entered)
  }

  private class RecordingLock : CrossProcessLock {
    var entries = 0
    private var held = false

    override fun <T> withLock(block: () -> T): T {
      check(!held) { "lock entered re-entrantly" }
      held = true
      entries++
      try {
        return block()
      } finally {
        held = false
      }
    }
  }

  private class FakeLaunchEnvironment(
    override val restartMode: DaemonRestartMode,
    var available: Boolean,
    var daemon: DaemonIdentity = DaemonIdentity(version = "0.0.40"),
    private val runner: DaemonIdentity = DaemonIdentity(version = "0.0.40"),
    private val launchSucceeds: Boolean = true,
    private val launchLeavesDaemonUnchanged: Boolean = false,
    override val runStartedAtMs: Long? = null,
  ) : DaemonLaunchEnvironment {
    val commands = mutableListOf<String>()
    override val startTimeoutMs: Long = 30_000L

    override fun isDaemonAvailable(): Boolean = available

    override fun daemonIdentity(): DaemonIdentity = daemon

    override fun runnerIdentity(): DaemonIdentity = runner

    override fun runLaunchCommand(restart: Boolean, skewDetected: Boolean) {
      commands.add(if (restart) "restart" else "start")
      if (launchSucceeds) {
        available = true
        // A relaunch starts after the run marker and with the runner's own flags.
        if (!launchLeavesDaemonUnchanged) {
          daemon = runner.copy(startedAtMs = (runStartedAtMs ?: 0L) + 1)
        }
      }
    }

    override fun awaitAvailability(): Boolean = available
  }
}
