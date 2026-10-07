package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.ServerSocketChannel
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Covers the stale-socket reconnect (#10169) and the cross-fork forced-restart decision (#10170)
 * with fakes only: no socket, no daemon process.
 */
class DaemonConnectRecoveryTest {

  // --- #10169: a refused connect on an already-ensured daemon re-ensures once -----------------

  @Test
  fun `refused connect re-ensures the daemon once and returns the reconnected client`() {
    val connected = Any()
    var connectCalls = 0
    var ensureCalls = 0

    val client =
      DaemonSocketClientManager.connectWithDaemonRecovery(
        connect = {
          connectCalls++
          if (connectCalls == 1) throw DaemonUnavailableException("Connection refused")
          connected
        },
        reEnsureDaemon = { ensureCalls++ },
      )

    assertSame(connected, client)
    assertEquals(1, ensureCalls)
    assertEquals(2, connectCalls)
  }

  @Test
  fun `a second refused connect surfaces as DaemonUnavailableException after one re-ensure`() {
    var ensureCalls = 0
    try {
      DaemonSocketClientManager.connectWithDaemonRecovery<Any>(
        connect = { throw DaemonUnavailableException("Connection refused") },
        reEnsureDaemon = { ensureCalls++ },
      )
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertTrue(e.message!!.contains("Connection refused"))
    }
    assertEquals(1, ensureCalls)
  }

  @Test
  fun `a stale socket file is reported as DaemonUnavailableException, not ConnectException`() {
    // Bind then close a Unix socket: the file stays behind and refuses connects, the state a
    // SIGKILLed daemon leaves. Local temp socket only; no daemon is involved.
    val dir = Files.createTempDirectory("stale-sock").toFile()
    try {
      val socketFile = File(dir, "d.sock")
      ServerSocketChannel.open(StandardProtocolFamily.UNIX).use {
        it.bind(UnixDomainSocketAddress.of(socketFile.path))
      }
      assertTrue(socketFile.exists())
      try {
        DaemonSocketClient(socketFile.path, null, null, null)
        fail("expected DaemonUnavailableException")
      } catch (e: DaemonUnavailableException) {
        assertTrue(e.cause is IOException)
      }
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun `a healthy connect never re-ensures the daemon`() {
    var ensureCalls = 0
    val connected = Any()

    val client =
      DaemonSocketClientManager.connectWithDaemonRecovery(
        connect = { connected },
        reEnsureDaemon = { ensureCalls++ },
      )

    assertSame(connected, client)
    assertEquals(0, ensureCalls)
  }

  // --- #10170: forced restart skips a daemon another fork of this run started ---------------

  @Test
  fun `forced restart reuses a daemon started after this runner JVM`() {
    assertFalse(
      DaemonSocketPaths.requiresForcedRestart(
        forceRestart = true,
        daemonAvailable = true,
        daemonStartedAtMs = 2_000L,
        runnerStartedAtMs = 1_000L,
      )
    )
  }

  @Test
  fun `forced restart replaces a daemon older than this runner JVM`() {
    assertTrue(
      DaemonSocketPaths.requiresForcedRestart(
        forceRestart = true,
        daemonAvailable = true,
        daemonStartedAtMs = 500L,
        runnerStartedAtMs = 1_000L,
      )
    )
  }

  @Test
  fun `forced restart is kept when either start time is unknown or the daemon is down`() {
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, true, null, 1_000L))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, true, 2_000L, null))
    assertTrue(DaemonSocketPaths.requiresForcedRestart(true, false, 2_000L, 1_000L))
  }

  @Test
  fun `no forced restart when force restart is off`() {
    assertFalse(DaemonSocketPaths.requiresForcedRestart(false, true, 500L, 1_000L))
    assertFalse(DaemonSocketPaths.requiresForcedRestart(false, true, 2_000L, 1_000L))
    assertFalse(DaemonSocketPaths.requiresForcedRestart(false, false, null, null))
  }

  @Test
  fun `two forks against one stale daemon issue a single forced restart`() {
    // A fake PID file whose startedAt is rewritten by the fake restart, read by each fork in turn.
    val pidFile = Files.createTempFile("daemon-pid", ".json").toFile()
    try {
      pidFile.writeText("""{"pid":1,"startedAt":100}""")
      var nowMs = 1_000L
      var restarts = 0
      val forkStartedAtMs = listOf(900L, 950L)

      forkStartedAtMs.forEach { runnerStartedAtMs ->
        val restart =
          DaemonSocketPaths.requiresForcedRestart(
            forceRestart = true,
            daemonAvailable = true,
            daemonStartedAtMs = DaemonSocketPaths.readDaemonStartedAtFromPidFile(pidFile.path),
            runnerStartedAtMs = runnerStartedAtMs,
          )
        if (restart) {
          restarts++
          nowMs += 10
          pidFile.writeText("""{"pid":2,"startedAt":$nowMs}""")
        }
      }

      assertEquals(1, restarts)
    } finally {
      pidFile.delete()
    }
  }

  @Test
  fun `readDaemonStartedAtFromPidFile returns null for a missing or malformed file`() {
    assertNull(DaemonSocketPaths.readDaemonStartedAtFromPidFile("/nonexistent/daemon.pid"))
    val pidFile = Files.createTempFile("daemon-pid", ".json").toFile()
    try {
      pidFile.writeText("not json")
      assertNull(DaemonSocketPaths.readDaemonStartedAtFromPidFile(pidFile.path))
      pidFile.writeText("""{"pid":1,"startedAt":1759750000123}""")
      assertEquals(1759750000123L, DaemonSocketPaths.readDaemonStartedAtFromPidFile(pidFile.path))
    } finally {
      pidFile.delete()
    }
  }

  @Test
  fun `withCrossProcessLock runs the block and releases the lock`() {
    val dir = Files.createTempDirectory("runner-lock").toFile()
    try {
      val lockPath = File(dir, "restart.lock").path
      assertEquals(1, DaemonSocketPaths.withCrossProcessLock(lockPath) { 1 })
      // Released: a second acquisition in the same JVM would throw if the first were still held.
      assertEquals(2, DaemonSocketPaths.withCrossProcessLock(lockPath) { 2 })
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun `an unopenable lock path surfaces as DaemonUnavailableException naming the path`() {
    val dir = Files.createTempDirectory("runner-lock").toFile()
    try {
      val lockPath = File(dir, "missing-dir/restart.lock").path
      var ran = false
      try {
        DaemonSocketPaths.withCrossProcessLock(lockPath) { ran = true }
        fail("expected DaemonUnavailableException")
      } catch (e: DaemonUnavailableException) {
        assertTrue(e.message!!.contains(lockPath))
        assertTrue(e.cause is IOException)
      }
      assertFalse(ran)
    } finally {
      dir.deleteRecursively()
    }
  }
}
