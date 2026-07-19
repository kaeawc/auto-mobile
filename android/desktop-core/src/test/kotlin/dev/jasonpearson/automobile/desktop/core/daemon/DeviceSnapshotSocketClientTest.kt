package dev.jasonpearson.automobile.desktop.core.daemon

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
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        resultJson = """{"config": ${configJson()}}""",
      )
      .use { server ->
        val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

        client.getConfig()

        val request = server.awaitRequest()
        assertEquals("config/get", request["method"]?.jsonPrimitive?.content)
        assertEquals("device_snapshot_request", request["type"]?.jsonPrimitive?.content)
        assertTrue(
          request["id"]?.jsonPrimitive?.content?.isNotBlank() == true,
          "id must be present",
        )
      }
  }

  @Test
  fun `config get decodes the whole config`() {
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        resultJson = """{"config": ${configJson()}}""",
      )
      .use { server ->
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
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        resultJson = """{"config": ${configJson(256)}}""",
      )
      .use { server ->
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
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        resultJson =
          """{"config": ${configJson(64)}, "evictedSnapshotNames": ["old-1", "old-2"]}""",
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
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        resultJson = """{"config": ${configJson()}}""",
      )
      .use { server ->
        val client = DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString())

        assertTrue(client.setConfig(DeviceSnapshotConfigInput()).evictedSnapshotNames.isEmpty())
      }
  }

  @Test
  fun `a failure response surfaces the daemon's message`() {
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        error = "config/set requires params.config",
      )
      .use { server ->
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
    TestConfigSocketServer(
        responseType = RESPONSE_TYPE,
        resultJson = """{"config": ${configJson()}}""",
      )
      .use { server ->
        assertTrue(
          DeviceSnapshotSocketClient(socketPathValue = server.socketPath.toString()).isAvailable()
        )
      }
  }

  private companion object {
    const val RESPONSE_TYPE = "device_snapshot_response"
  }
}
