package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.ServerSocketChannel
import java.nio.file.Files
import org.junit.Assert.assertEquals
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

  @Test
  fun `connect failure on an already-ensured daemon re-ensures once and retries`() {
    var ensures = 0
    val connections =
      FakeConnections(
        mutableListOf(
          { "first" },
          { throw ConnectException("Connection refused") },
          { "after-restart" },
        )
      )
    val provider =
      DaemonConnectionProvider(
        socketExists = { true },
        ensureDaemon = { ensures++ },
        connect = connections::connect,
      )

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
    val provider =
      DaemonConnectionProvider<String>(
        socketExists = { true },
        ensureDaemon = { ensures++ },
        connect = { throw refused },
      )

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
  fun `DaemonUnavailableException from connect also triggers one re-ensure`() {
    var ensures = 0
    val connections =
      FakeConnections(
        mutableListOf(
          { throw DaemonUnavailableException("Daemon socket connect failed") },
          { "ok" },
        )
      )
    val provider =
      DaemonConnectionProvider(
        socketExists = { true },
        ensureDaemon = { ensures++ },
        connect = connections::connect,
      )

    assertEquals("ok", provider.open())
    assertEquals(2, ensures)
  }

  @Test
  fun `healthy daemon is ensured once per provider`() {
    var ensures = 0
    val provider =
      DaemonConnectionProvider(
        socketExists = { true },
        ensureDaemon = { ensures++ },
        connect = { "c" },
      )

    repeat(3) { provider.open() }

    assertEquals(1, ensures)
  }

  @Test
  fun `missing socket file re-ensures before connecting`() {
    var ensures = 0
    var socketPresent = true
    val provider =
      DaemonConnectionProvider(
        socketExists = { socketPresent },
        ensureDaemon = { ensures++ },
        connect = { "c" },
      )

    provider.open()
    socketPresent = false
    provider.open()

    assertEquals(2, ensures)
  }

  @Test
  fun `ensure failure propagates without a connect attempt`() {
    var connects = 0
    val provider =
      DaemonConnectionProvider(
        socketExists = { false },
        ensureDaemon = { throw DaemonUnavailableException("Daemon failed to start within 1ms") },
        connect = {
          connects++
          "c"
        },
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
  fun `connecting to a stale socket file throws DaemonUnavailableException`() {
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
      }
    } finally {
      dir.deleteRecursively()
    }
  }
}
