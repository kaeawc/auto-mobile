package dev.jasonpearson.automobile.junit

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DaemonLauncherTest {

  /** One shared daemon seen by every runner; [launch] restarts it at the fake clock's time. */
  private class FakeDaemon(
    var available: Boolean = true,
    var record: DaemonPidRecord = DaemonPidRecord(version = "1.0.0", startedAtMs = 100),
    var nowMs: Long = 1_000,
  ) {
    val launches = mutableListOf<Boolean>()
    var recordAfterLaunch: DaemonPidRecord? = null
    var startsWithinTimeout = true

    fun launch(restart: Boolean) {
      launches += restart
      available = startsWithinTimeout
      record = recordAfterLaunch ?: record.copy(startedAtMs = nowMs)
    }
  }

  private class FakeEnvironment(
    private val daemon: FakeDaemon,
    override val forceRestartRequested: Boolean = true,
    override val runnerStartedAtMs: Long? = 500,
    override val clientIdentity: DaemonClientIdentity = DaemonClientIdentity(version = "1.0.0"),
  ) : DaemonLaunchEnvironment {
    var lockedCalls = 0
    var inLock = false
    val decisionsOutsideLock = mutableListOf<String>()

    override val startTimeoutMs: Long = 1

    override fun isDaemonAvailable(): Boolean {
      if (!inLock) decisionsOutsideLock += "isDaemonAvailable"
      return daemon.available
    }

    override fun readPidRecord(): DaemonPidRecord = daemon.record

    override fun launch(restart: Boolean) {
      if (!inLock) decisionsOutsideLock += "launch"
      daemon.launch(restart)
    }

    override fun waitForDaemon(timeoutMs: Long): Boolean = daemon.available

    override fun <T> withRunnerRestartLock(block: () -> T): T {
      lockedCalls++
      inLock = true
      try {
        return block()
      } finally {
        inLock = false
      }
    }

    override fun debugLog(message: String) = Unit
  }

  @Test
  fun `stale daemon is force-restarted once, then reused by the next decision`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "1.0.0", startedAtMs = 100))
    val env = FakeEnvironment(daemon, runnerStartedAtMs = 500)

    DaemonLauncher.ensureRunning(env)
    DaemonLauncher.ensureRunning(env)

    assertEquals(listOf(true), daemon.launches)
  }

  @Test
  fun `a parallel fork reuses the daemon another fork of the run restarted`() {
    // Fork A and fork B both started at 500/510; the daemon was left by an earlier job at 100.
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "1.0.0", startedAtMs = 100))
    val forkA = FakeEnvironment(daemon, runnerStartedAtMs = 500)
    val forkB = FakeEnvironment(daemon, runnerStartedAtMs = 510)

    DaemonLauncher.ensureRunning(forkA)
    // Fork B's first call: today this issues a second `--daemon restart` and kills A's plan
    // (#10170).
    DaemonLauncher.ensureRunning(forkB)

    assertEquals(listOf(true), daemon.launches)
  }

  @Test
  fun `undated daemon keeps the forced restart`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "1.0.0", startedAtMs = null))

    DaemonLauncher.ensureRunning(FakeEnvironment(daemon))

    assertEquals(listOf(true), daemon.launches)
  }

  @Test
  fun `without a forced restart a healthy daemon is reused`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "1.0.0", startedAtMs = 100))

    DaemonLauncher.ensureRunning(FakeEnvironment(daemon, forceRestartRequested = false))

    assertEquals(emptyList<Boolean>(), daemon.launches)
  }

  @Test
  fun `unavailable daemon is started without a restart when no restart is requested`() {
    val daemon = FakeDaemon(available = false)

    DaemonLauncher.ensureRunning(FakeEnvironment(daemon, forceRestartRequested = false))

    assertEquals(listOf(false), daemon.launches)
  }

  @Test
  fun `version skew still restarts a daemon started after this runner`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "0.9.0", startedAtMs = 900))
    daemon.recordAfterLaunch = DaemonPidRecord(version = "1.0.0", startedAtMs = 1_000)

    DaemonLauncher.ensureRunning(FakeEnvironment(daemon, runnerStartedAtMs = 500))

    assertEquals(listOf(true), daemon.launches)
  }

  @Test
  fun `check and restart run under the runner restart lock`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "1.0.0", startedAtMs = 100))
    val env = FakeEnvironment(daemon)

    DaemonLauncher.ensureRunning(env)

    assertEquals(1, env.lockedCalls)
    assertEquals(emptyList<String>(), env.decisionsOutsideLock)
  }

  @Test
  fun `asset version pin mismatch without a forced restart fails immediately`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "1.0.0", assetVersion = "0.0.1"))
    val env =
      FakeEnvironment(
        daemon,
        forceRestartRequested = false,
        clientIdentity = DaemonClientIdentity(version = "1.0.0", assetVersionPin = "0.0.2"),
      )

    try {
      DaemonLauncher.ensureRunning(env)
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertTrue(e.message.orEmpty().contains("AUTOMOBILE_VERSION mismatch"))
    }
    assertEquals(emptyList<Boolean>(), daemon.launches)
  }

  @Test
  fun `daemon still skewed after restart is reported`() {
    val daemon = FakeDaemon(record = DaemonPidRecord(version = "0.9.0", startedAtMs = 100))
    daemon.recordAfterLaunch = DaemonPidRecord(version = "0.9.0", startedAtMs = 1_000)

    try {
      DaemonLauncher.ensureRunning(FakeEnvironment(daemon))
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertTrue(e.message.orEmpty().contains("still differs"))
    }
  }

  @Test
  fun `daemon that never comes up is reported`() {
    val daemon = FakeDaemon(available = false)
    daemon.startsWithinTimeout = false

    try {
      DaemonLauncher.ensureRunning(FakeEnvironment(daemon))
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertEquals("Daemon failed to start within 1ms", e.message)
    }
  }

  @Test
  fun `requiresForcedRestart decision table`() {
    // The case that fails today: a fresh daemon from another fork of this run.
    assertFalse(DaemonSocketPaths.requiresForcedRestart(true, true, 2_000, 1_000))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, true, 500, 1_000))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, true, 1_000, 1_000))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, true, null, 1_000))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, true, 2_000, null))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, false, 2_000, 1_000))
    listOf(true, false).forEach { available ->
      listOf<Long?>(null, 500, 2_000).forEach { daemonStarted ->
        assertFalse(DaemonSocketPaths.requiresForcedRestart(false, available, daemonStarted, 1_000))
      }
    }
  }

  @Test
  fun `startedAt is read from the pid file as epoch milliseconds`() {
    val pidFile = Files.createTempFile("am-pid", ".json").toFile()
    try {
      pidFile.writeText("""{"pid":42,"startedAt":1759750000123,"version":"1.0.0"}""")
      assertEquals(
        1_759_750_000_123L,
        DaemonSocketPaths.readDaemonStartedAtMsFromPidFile(pidFile.path),
      )

      pidFile.writeText("""{"pid":42}""")
      assertNull(DaemonSocketPaths.readDaemonStartedAtMsFromPidFile(pidFile.path))
    } finally {
      pidFile.delete()
    }
    assertNull(DaemonSocketPaths.readDaemonStartedAtMsFromPidFile(pidFile.path))
  }

  @Test
  fun `runner restart lock sits next to the daemon socket`() {
    val lockPath = DaemonSocketPaths.runnerRestartLockPath()
    assertEquals(
      DaemonSocketPaths.socketPath().removeSuffix(".sock"),
      lockPath.removeSuffix(".runner-restart.lock"),
    )
  }

  @Test
  fun `cross-process file lock runs the block and releases the lock`() {
    val dir = Files.createTempDirectory("am-lock").toFile()
    val lockFile = File(dir, "restart.lock")
    val unavailable = mutableListOf<Exception>()
    try {
      val result = withCrossProcessFileLock(lockFile.path, { unavailable += it }) { "ran" }
      assertEquals("ran", result)
      assertEquals(emptyList<Exception>(), unavailable)

      // Released: the file can be locked again.
      java.nio.channels.FileChannel.open(lockFile.toPath(), StandardOpenOption.WRITE).use { ch ->
        val lock = ch.tryLock()
        assertTrue(lock != null)
        lock?.release()
      }
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun `cross-process file lock degrades to unlocked when it cannot be taken`() {
    val dir = Files.createTempDirectory("am-lock").toFile()
    val lockFile = File(dir, "restart.lock")
    val unavailable = mutableListOf<Exception>()
    try {
      // This JVM already holds the lock on another channel: OverlappingFileLockException.
      val nested =
        withCrossProcessFileLock(lockFile.path, { unavailable += it }) {
          withCrossProcessFileLock(lockFile.path, { unavailable += it }) { "inner" }
        }
      assertEquals("inner", nested)
      assertEquals(1, unavailable.size)

      // Unwritable path: the parent is a regular file.
      val blocker = File(dir, "blocker").apply { writeText("x") }
      val result =
        withCrossProcessFileLock(File(blocker, "restart.lock").path, { unavailable += it }) { 7 }
      assertEquals(7, result)
      assertEquals(2, unavailable.size)
    } finally {
      dir.deleteRecursively()
    }
  }
}
