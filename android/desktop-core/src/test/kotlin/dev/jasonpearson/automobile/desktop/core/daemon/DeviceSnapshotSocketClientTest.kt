package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Covers [DeviceSnapshotSocketClient] against a real in-process Unix socket, mirroring the harness
 * in `McpDaemonClientInputTest`.
 */
class DeviceSnapshotSocketClientTest {

  private val json = Json { ignoreUnknownKeys = true }

  private fun configJson(maxArchiveSizeMb: Long = 512) =
    """
    {
      "includeAppData": true,
      "includeSettings": false,
      "useVmSnapshot": true,
      "strictBackupMode": false,
      "backupTimeoutMs": 1000,
      "userApps": "all",
      "vmSnapshotTimeoutMs": 2000,
      "maxArchiveSizeMb": $maxArchiveSizeMb
    }
    """

  @Test
  fun `config get sends the documented envelope`() {
    TestConfigSocket(resultJson = """{"config": ${configJson()}}""").use { server ->
      val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

      client.getConfig()

      val request = server.awaitRequest()
      assertEquals("config/get", request["method"]?.jsonPrimitive?.content)
      assertEquals("device_snapshot_request", request["type"]?.jsonPrimitive?.content)
      assertTrue(request["id"]?.jsonPrimitive?.content?.isNotBlank() == true, "id must be present")
    }
  }

  @Test
  fun `config get decodes the whole config`() {
    TestConfigSocket(resultJson = """{"config": ${configJson()}}""").use { server ->
      val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

      val result = client.getConfig()

      assertEquals(true, result.config.includeAppData)
      assertEquals(false, result.config.includeSettings)
      assertEquals(true, result.config.useVmSnapshot)
      assertEquals("all", result.config.userApps)
      assertEquals(512L, result.config.maxArchiveSizeMb)
      assertTrue(result.evictedSnapshotNames.isEmpty(), "reads never evict")
    }
  }

  @Test
  fun `config set nests the partial update under params config`() {
    TestConfigSocket(resultJson = """{"config": ${configJson(256)}}""").use { server ->
      val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

      client.setConfig(DeviceSnapshotConfigInput(maxArchiveSizeMb = 256))

      val request = server.awaitRequest()
      assertEquals("config/set", request["method"]?.jsonPrimitive?.content)
      val config = request["params"]?.jsonObject?.get("config")?.jsonObject
      assertEquals(256L, config?.get("maxArchiveSizeMb")?.jsonPrimitive?.content?.toLong())
      // Unset fields must be omitted so a partial update doesn't overwrite the rest.
      assertTrue(config?.containsKey("includeAppData") != true, "expected omitted, got $config")
    }
  }

  @Test
  fun `evicted snapshot names are surfaced from a set`() {
    TestConfigSocket(
        resultJson =
          """{"config": ${configJson(64)}, "evictedSnapshotNames": ["old-1", "old-2"]}"""
      )
      .use { server ->
        val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

        val result = client.setConfig(DeviceSnapshotConfigInput(maxArchiveSizeMb = 64))

        assertEquals(listOf("old-1", "old-2"), result.evictedSnapshotNames)
      }
  }

  @Test
  fun `an absent evicted list defaults to empty rather than failing to decode`() {
    // The daemon omits the key entirely when nothing was evicted.
    TestConfigSocket(resultJson = """{"config": ${configJson()}}""").use { server ->
      val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

      assertTrue(client.setConfig(DeviceSnapshotConfigInput()).evictedSnapshotNames.isEmpty())
    }
  }

  @Test
  fun `a failure response surfaces the daemon's message`() {
    TestConfigSocket(error = "config/set requires params.config").use { server ->
      val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

      val failure = assertFailsWith<McpConnectionException> { client.getConfig() }

      assertEquals("config/set requires params.config", failure.message)
    }
  }

  @Test
  fun `a missing socket reports the path rather than throwing something opaque`() {
    val client = DeviceSnapshotSocketClient(socketPathValue = "/tmp/does-not-exist-am.sock")

    val failure = assertFailsWith<McpConnectionException> { client.getConfig() }

    assertTrue(
      failure.message!!.contains("/tmp/does-not-exist-am.sock"),
      "message should name the socket: ${failure.message}",
    )
  }

  @Test
  fun `isAvailable is false for a daemon that predates this socket`() {
    assertTrue(!DeviceSnapshotSocketClient(socketPathValue = "/tmp/nope-am.sock").isAvailable())
  }

  @Test
  fun `isAvailable is true once the socket is bound`() {
    TestConfigSocket(resultJson = """{"config": ${configJson()}}""").use { server ->
      assertTrue(
        DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString()).isAvailable()
      )
    }
  }

  /** A one-shot Unix socket server speaking the daemon's config-socket envelope. */
  private inner class TestConfigSocket(
    private val resultJson: String? = null,
    private val error: String? = null,
  ) : AutoCloseable {
    private val tempDir = Files.createTempDirectory(Path.of("/tmp"), "amsnap-")
    val socketPath: Path = tempDir.resolve("device-snapshot.sock")
    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))
    private var captured: kotlinx.serialization.json.JsonObject? = null
    private var failure: Throwable? = null
    private val thread =
      Thread {
          try {
            serverChannel.accept().use { channel ->
              val reader =
                BufferedReader(
                  InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8)
                )
              val writer =
                BufferedWriter(
                  OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
                )
              val request = json.parseToJsonElement(reader.readLine()).jsonObject
              captured = request
              writer.write(responseLine(request["id"]?.jsonPrimitive?.content ?: "unknown"))
              writer.newLine()
              writer.flush()
            }
          } catch (throwable: Throwable) {
            failure = throwable
          }
        }
        .also { it.start() }

    fun awaitRequest(): kotlinx.serialization.json.JsonObject {
      thread.join(REQUEST_TIMEOUT_MILLIS)
      if (thread.isAlive) throw AssertionError("Client did not send a request before timeout")
      failure?.let { throw AssertionError("Test config socket failed", it) }
      return captured ?: throw AssertionError("Client did not send a request")
    }

    private fun responseLine(requestId: String): String {
      val compactResult = (resultJson ?: "{}").lineSequence().joinToString("") { it.trim() }
      val body =
        if (error == null) """"result": $compactResult"""
        else """"error": ${kotlinx.serialization.json.JsonPrimitive(error)}"""
      return """{"id":"$requestId","type":"device_snapshot_response","success":${error == null},$body}"""
    }

    override fun close() {
      serverChannel.close()
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }
  }

  private companion object {
    const val REQUEST_TIMEOUT_MILLIS = 5_000L
  }
}
