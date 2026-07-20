package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Socket file the daemon binds for device-snapshot configuration. */
internal const val DEVICE_SNAPSHOT_SOCKET_FILE = "device-snapshot.sock"

/**
 * Retention and capture defaults for device snapshots, as stored by the daemon.
 *
 * Every field is required in a daemon response; defaults exist only so that a daemon which grows a
 * new field doesn't break decoding here.
 */
@Serializable
data class DeviceSnapshotConfig(
  val includeAppData: Boolean = true,
  val includeSettings: Boolean = true,
  val useVmSnapshot: Boolean = false,
  val strictBackupMode: Boolean = false,
  val backupTimeoutMs: Long = 0,
  val userApps: String = "current",
  val vmSnapshotTimeoutMs: Long = 0,
  val maxArchiveSizeMb: Long = 0,
)

/**
 * A partial config update. Only non-null fields are sent, so callers can change one setting without
 * restating the rest.
 */
@Serializable
data class DeviceSnapshotConfigInput(
  val includeAppData: Boolean? = null,
  val includeSettings: Boolean? = null,
  val useVmSnapshot: Boolean? = null,
  val strictBackupMode: Boolean? = null,
  val backupTimeoutMs: Long? = null,
  val userApps: String? = null,
  val vmSnapshotTimeoutMs: Long? = null,
  val maxArchiveSizeMb: Long? = null,
)

/**
 * Result of a config read or write.
 *
 * [evictedSnapshotNames] is only ever populated by a write that shrank the archive budget; the
 * daemon omits the field entirely when nothing was evicted, and on every read.
 */
data class DeviceSnapshotConfigResult(
  val config: DeviceSnapshotConfig,
  val evictedSnapshotNames: List<String> = emptyList(),
)

/** Reads and writes the daemon's device-snapshot configuration. */
interface DeviceSnapshotConfigClient {
  fun getConfig(): DeviceSnapshotConfigResult

  /** Applies a partial update. Passing an all-null [input] resets the config to daemon defaults. */
  fun setConfig(input: DeviceSnapshotConfigInput): DeviceSnapshotConfigResult

  /** True when the daemon exposes this socket; false on daemons that predate it. */
  fun isAvailable(): Boolean
}

/**
 * Client for `~/.auto-mobile/device-snapshot.sock`.
 *
 * This socket is a *config* socket: its entire method surface is `config/get` and `config/set`.
 * Capturing and restoring snapshots is not available here -- those are MCP tool actions, exposed
 * through [DeviceSnapshotActions].
 *
 * One request per connection, matching the daemon's line-per-message request/response contract.
 */
class DeviceSnapshotSocketClient(
  private val socketPathValue: String =
    AutoMobileSocketPaths.socketPath(DEVICE_SNAPSHOT_SOCKET_FILE),
  private val json: Json = DaemonJson,
) : DeviceSnapshotConfigClient {

  override fun isAvailable(): Boolean = Files.exists(File(socketPathValue).toPath())

  override fun getConfig(): DeviceSnapshotConfigResult =
    send(DeviceSnapshotSocketRequest(id = UUID.randomUUID().toString(), method = "config/get"))

  override fun setConfig(input: DeviceSnapshotConfigInput): DeviceSnapshotConfigResult =
    send(
      DeviceSnapshotSocketRequest(
        id = UUID.randomUUID().toString(),
        method = "config/set",
        // `config` must be present for config/set even when empty -- the daemon rejects a request
        // whose params omit the key.
        params = DeviceSnapshotSocketParams(config = input),
      )
    )

  private fun send(request: DeviceSnapshotSocketRequest): DeviceSnapshotConfigResult {
    ensureSocketExists()

    val address = UnixDomainSocketAddress.of(socketPathValue)
    SocketChannel.open(address).use { channel ->
      val reader =
        BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
      val writer =
        BufferedWriter(
          OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
        )

      writer.write(json.encodeToString(DeviceSnapshotSocketRequest.serializer(), request))
      writer.newLine()
      writer.flush()

      val line = reader.readLine() ?: throw McpConnectionException("Device snapshot socket closed")
      val response = json.decodeFromString(DeviceSnapshotSocketResponse.serializer(), line)

      if (!response.success) {
        throw McpConnectionException(response.error ?: "Device snapshot request failed")
      }
      val result =
        response.result ?: throw McpConnectionException("Device snapshot response missing result")

      return DeviceSnapshotConfigResult(
        config = result.config,
        evictedSnapshotNames = result.evictedSnapshotNames,
      )
    }
  }

  private fun ensureSocketExists() {
    if (!isAvailable()) {
      throw McpConnectionException("Device snapshot socket not found at $socketPathValue")
    }
  }
}

@Serializable
internal data class DeviceSnapshotSocketRequest(
  val id: String,
  val type: String = "device_snapshot_request",
  val method: String,
  val params: DeviceSnapshotSocketParams? = null,
)

@Serializable internal data class DeviceSnapshotSocketParams(val config: DeviceSnapshotConfigInput?)

@Serializable
internal data class DeviceSnapshotSocketResponse(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean = false,
  val result: DeviceSnapshotSocketResult? = null,
  val error: String? = null,
)

@Serializable
internal data class DeviceSnapshotSocketResult(
  val config: DeviceSnapshotConfig,
  // Absent on reads and on writes that evicted nothing.
  val evictedSnapshotNames: List<String> = emptyList(),
)

/** In-memory [DeviceSnapshotConfigClient] for previews and tests. */
class FakeDeviceSnapshotConfigClient(
  initialConfig: DeviceSnapshotConfig = DeviceSnapshotConfig(),
  private val available: Boolean = true,
  /** Names reported as evicted by the next [setConfig], mirroring a shrunken archive budget. */
  private val evictOnSet: List<String> = emptyList(),
) : DeviceSnapshotConfigClient {
  var config: DeviceSnapshotConfig = initialConfig
    private set

  override fun isAvailable(): Boolean = available

  override fun getConfig(): DeviceSnapshotConfigResult = DeviceSnapshotConfigResult(config)

  override fun setConfig(input: DeviceSnapshotConfigInput): DeviceSnapshotConfigResult {
    config =
      config.copy(
        includeAppData = input.includeAppData ?: config.includeAppData,
        includeSettings = input.includeSettings ?: config.includeSettings,
        useVmSnapshot = input.useVmSnapshot ?: config.useVmSnapshot,
        strictBackupMode = input.strictBackupMode ?: config.strictBackupMode,
        backupTimeoutMs = input.backupTimeoutMs ?: config.backupTimeoutMs,
        userApps = input.userApps ?: config.userApps,
        vmSnapshotTimeoutMs = input.vmSnapshotTimeoutMs ?: config.vmSnapshotTimeoutMs,
        maxArchiveSizeMb = input.maxArchiveSizeMb ?: config.maxArchiveSizeMb,
      )
    return DeviceSnapshotConfigResult(config, evictOnSet)
  }
}
