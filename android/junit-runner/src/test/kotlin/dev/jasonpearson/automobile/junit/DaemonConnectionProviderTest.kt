package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.ServerSocketChannel
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DaemonConnectionProviderTest {

  private class FakeConnections(private val outcomes: MutableList<() -> String>) {
    var connects = 0

    fun connect(): String {
      connects++
      return outcomes.removeAt(0).invoke()
    }
  }

  private class FakeClock(var nowMs: Long = 0)

  private fun <C> provider(
    connect: () -> C,
    ensureDaemon: () -> Unit,
    socketExists: () -> Boolean = { true },
    daemonProcessAlive: () -> Boolean = { false },
    clock: FakeClock = FakeClock(),
  ) =
    DaemonConnectionProvider(
      socketExists = socketExists,
      ensureDaemon = ensureDaemon,
      connect = connect,
      daemonProcessAlive = daemonProcessAlive,
      nowMs = { clock.nowMs },
      ensureFailureCooldownMs = 30_000,
    )

  @Test
  fun `connect failure on an already-ensured daemon re-ensures once and retries`() {
    var ensures = 0
    val connections =
      FakeConnections(
        mutableListOf(
          { "first" },
          { throw ConnectException("Connection refused") },
          { "after-restart" },
        ),
      )
    val provider = provider(connections::connect, { ensures++ })

    assertEquals("first", provider.open())
    assertEquals(1, ensures)

    // The daemon died leaving its socket file: the next open must not surface the raw
    // ConnectException (#10169).
    assertEquals("after-restart", provider.open())
    assertEquals(2, ensures)
    assertEquals(3, connections.connects)
  }

  @Test
  fun `second connect failure surfaces as DaemonUnavailableException`() {
    var ensures = 0
    val refused = ConnectException("Connection refused")
    val provider = provider<String>({ throw refused }, { ensures++ })

    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertSame(refused, e.cause)
      assertTrue(e.message.orEmpty().contains("daemon"))
    }
    assertEquals(2, ensures)
  }

  @Test
  fun `wrapped refused connect from the socket client also triggers one re-ensure`() {
    var ensures = 0
    val connections =
      FakeConnections(
        mutableListOf(
          {
            throw DaemonUnavailableException(
              "Daemon socket connect failed",
              ConnectException("Connection refused"),
            )
          },
          { "ok" },
        ),
      )
    val provider = provider(connections::connect, { ensures++ })

    assertEquals("ok", provider.open())
    assertEquals(2, ensures)
  }

  @Test
  fun `local connect failure such as EMFILE surfaces without restarting the daemon`() {
    var ensures = 0
    var aliveChecks = 0
    val emfile =
      DaemonUnavailableException(
        "Daemon socket connect failed",
        SocketException("Too many open files"),
      )
    val connections = FakeConnections(mutableListOf({ "first" }, { throw emfile }))
    val provider =
      provider(
        connections::connect,
        { ensures++ },
        daemonProcessAlive = {
          aliveChecks++
          true
        },
      )

    provider.open()
    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertSame(emfile, e)
    }
    assertEquals(1, ensures)
    assertEquals(0, aliveChecks)
    assertEquals(2, connections.connects)
  }

  @Test
  fun `raw local IOException is wrapped and does not restart the daemon`() {
    var ensures = 0
    val emfile = IOException("Too many open files")
    val connections = FakeConnections(mutableListOf({ "first" }, { throw emfile }))
    val provider = provider(connections::connect, { ensures++ })

    provider.open()
    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertSame(emfile, e.cause)
      assertTrue(e.message.orEmpty().contains("not restarting"))
    }
    assertEquals(1, ensures)
  }

  @Test
  fun `refused connect while the daemon process is alive does not restart it`() {
    var ensures = 0
    val refused = ConnectException("Connection refused")
    val connections = FakeConnections(mutableListOf({ "first" }, { throw refused }))
    val provider = provider(connections::connect, { ensures++ }, daemonProcessAlive = { true })

    provider.open()
    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertSame(refused, e.cause)
      assertTrue(e.message.orEmpty().contains("still alive"))
    }
    assertEquals(1, ensures)
  }

  @Test
  fun `failed ensure is remembered for the cooldown, then retried`() {
    var ensures = 0
    var ensureFails = true
    val clock = FakeClock(nowMs = 1_000)
    val provider =
      provider(
        { "c" },
        {
          ensures++
          if (ensureFails) throw DaemonUnavailableException("Daemon failed to start within 1ms")
        },
        clock = clock,
      )

    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertEquals("Daemon failed to start within 1ms", e.message)
    }

    // Within the cooldown later tests fail fast without re-running the restart.
    clock.nowMs = 30_999
    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertTrue(e.message.orEmpty().contains("not retrying"))
      assertTrue(e.message.orEmpty().contains("Daemon failed to start within 1ms"))
    }
    assertEquals(1, ensures)

    // After the cooldown the ensure runs again.
    clock.nowMs = 31_000
    ensureFails = false
    assertEquals("c", provider.open())
    assertEquals(2, ensures)
  }

  @Test
  fun `healthy daemon is ensured once per provider`() {
    var ensures = 0
    val provider = provider({ "c" }, { ensures++ })

    repeat(3) { provider.open() }

    assertEquals(1, ensures)
  }

  @Test
  fun `missing socket file re-ensures before connecting`() {
    var ensures = 0
    var socketPresent = true
    val provider = provider({ "c" }, { ensures++ }, socketExists = { socketPresent })

    provider.open()
    socketPresent = false
    provider.open()

    assertEquals(2, ensures)
  }

  @Test
  fun `ensure failure propagates without a connect attempt`() {
    var connects = 0
    val provider =
      provider(
        {
          connects++
          "c"
        },
        { throw DaemonUnavailableException("Daemon failed to start within 1ms") },
        socketExists = { false },
      )

    try {
      provider.open()
      fail("expected DaemonUnavailableException")
    } catch (e: DaemonUnavailableException) {
      assertEquals("Daemon failed to start within 1ms", e.message)
    }
    assertEquals(0, connects)
  }

  @Test
  fun `dead-daemon classification`() {
    assertTrue(DaemonConnectFailures.indicatesDeadDaemon(DaemonSocketMissingException("/x.sock")))
    assertTrue(DaemonConnectFailures.indicatesDeadDaemon(ConnectException("Connection refused")))
    assertTrue(
      DaemonConnectFailures.indicatesDeadDaemon(SocketException("No such file or directory")),
    )
    assertTrue(
      DaemonConnectFailures.indicatesDeadDaemon(
        DaemonUnavailableException("wrapped", ConnectException("Connection refused")),
      ),
    )
    assertFalse(DaemonConnectFailures.indicatesDeadDaemon(SocketException("Too many open files")))
    assertFalse(DaemonConnectFailures.indicatesDeadDaemon(IOException("Permission denied")))
    assertFalse(DaemonConnectFailures.indicatesDeadDaemon(DaemonUnavailableException("timeout")))
    assertTrue(
      DaemonProbe.fromConnectFailure(ConnectException("Connection refused"))
        is DaemonProbe.NotRunning,
    )
    assertTrue(
      DaemonProbe.fromConnectFailure(IOException("Too many open files")) is DaemonProbe.Unreachable,
    )
  }

  @Test
  fun `pid liveness treats an unknown pid as dead`() {
    assertFalse(DaemonSocketPaths.isProcessAlive(null) { true })
    assertTrue(DaemonSocketPaths.isProcessAlive(42) { it == 42L })
    assertFalse(DaemonSocketPaths.isProcessAlive(42) { false })
    assertTrue(DaemonSocketPaths.isProcessAlive(ProcessHandle.current().pid()))
  }

  @Test
  fun `pid is read from the pid file`() {
    val pidFile = Files.createTempFile("am-pid", ".json").toFile()
    try {
      pidFile.writeText("""{"pid":4242,"startedAt":1}""")
      assertEquals(4242L, DaemonSocketPaths.readDaemonPidFromPidFile(pidFile.path))
      pidFile.writeText("""{"pid":0}""")
      assertEquals(null, DaemonSocketPaths.readDaemonPidFromPidFile(pidFile.path))
    } finally {
      pidFile.delete()
    }
  }

  @Test
  fun `connecting to a stale socket file probes as not running`() {
    // A closed server leaves its socket file behind, exactly like a SIGKILLed daemon.
    val dir = Files.createTempDirectory("am-stale").toFile()
    val socketFile = File(dir, "d.sock")
    try {
      ServerSocketChannel.open(StandardProtocolFamily.UNIX).use {
        it.bind(UnixDomainSocketAddress.of(socketFile.toPath()))
      }
      assertTrue(socketFile.exists())

      try {
        DaemonSocketClient(socketFile.path, null, null, null)
        fail("expected DaemonUnavailableException")
      } catch (e: DaemonUnavailableException) {
        assertTrue(e.cause is IOException)
        assertTrue(DaemonConnectFailures.indicatesDeadDaemon(e))
      }
      assertSame(DaemonProbe.NotRunning, DaemonSocketClient.probe(socketFile.path))
      assertSame(DaemonProbe.NotRunning, DaemonSocketClient.probe(File(dir, "gone.sock").path))
    } finally {
      dir.deleteRecursively()
    }
  }
}
