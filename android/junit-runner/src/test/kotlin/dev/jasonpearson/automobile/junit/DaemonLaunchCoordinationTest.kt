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
    // mode, daemonAvailable, skew -> action
    val table =
      listOf(
        Triple(never, true, false) to reuse,
        Triple(never, true, true) to restart,
        Triple(never, false, false) to start,
        Triple(ifNeeded, true, false) to reuse,
        Triple(ifNeeded, true, true) to restart,
        Triple(ifNeeded, false, false) to restart,
        Triple(always, true, false) to restart,
        Triple(always, true, true) to restart,
        Triple(always, false, false) to restart,
      )
    for ((input, expected) in table) {
      val (mode, available, skew) = input
      assertEquals(
        expected,
        decideDaemonLaunch(mode, available, skew),
        "mode=$mode available=$available skew=$skew",
      )
    }
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

    val result = FileCrossProcessLock(missingDirectory, timeoutMs = 1L).withLock { "ran" }

    assertEquals("ran", result)
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
        if (!launchLeavesDaemonUnchanged) daemon = runner
      }
    }

    override fun awaitAvailability(): Boolean = available
  }
}
