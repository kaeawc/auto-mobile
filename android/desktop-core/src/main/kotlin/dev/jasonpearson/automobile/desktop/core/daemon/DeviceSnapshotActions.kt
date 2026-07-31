package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

/** MCP resource listing every captured snapshot. */
internal const val DEVICE_SNAPSHOT_ARCHIVE_URI = "automobile:deviceSnapshots/archive"

private val snapshotJson = DaemonJson

/** Metadata for one captured snapshot, as listed by the archive resource. */
@Serializable
data class DeviceSnapshotMetadata(
  val snapshotName: String,
  val deviceId: String = "",
  val deviceName: String = "",
  val platform: String = "",
  val snapshotType: String = "",
  val includeAppData: Boolean = false,
  val includeSettings: Boolean = false,
  val createdAt: String = "",
  val lastAccessedAt: String = "",
  val sizeBytes: Long = 0,
)

/** The archive resource payload. */
@Serializable
internal data class DeviceSnapshotArchive(
  val snapshots: List<DeviceSnapshotMetadata> = emptyList(),
  val count: Int = 0,
  val totalSizeBytes: Long = 0,
  val error: String? = null,
)

/** Outcome of a capture, including anything the daemon evicted to make room. */
data class DeviceSnapshotCaptureResult(
  val snapshotName: String,
  val snapshotType: String,
  val evictedSnapshotNames: List<String> = emptyList(),
)

/**
 * Capture, restore and list operations for device snapshots.
 *
 * These are deliberately *not* on `device-snapshot.sock` -- that socket only carries configuration.
 * The verbs are MCP tool actions and a resource read, so they go over the regular client.
 */
interface DeviceSnapshotActions {
  fun listSnapshots(): List<DeviceSnapshotMetadata>

  fun captureSnapshot(deviceId: String, snapshotName: String? = null): DeviceSnapshotCaptureResult

  fun restoreSnapshot(deviceId: String, snapshotName: String)
}

/** [DeviceSnapshotActions] backed by the `deviceSnapshot` MCP tool and the archive resource. */
class McpDeviceSnapshotActions(private val clientProvider: () -> AutoMobileClient) :
  DeviceSnapshotActions {
  private val client by lazy(clientProvider)

  override fun listSnapshots(): List<DeviceSnapshotMetadata> {
    val archive =
      decodeResourceResponse(
        snapshotJson,
        client.readResource(DEVICE_SNAPSHOT_ARCHIVE_URI),
        serializer<DeviceSnapshotArchive>(),
      )
    return archive.snapshots
  }

  override fun captureSnapshot(
    deviceId: String,
    snapshotName: String?,
  ): DeviceSnapshotCaptureResult {
    val response =
      callSnapshotTool(
        buildJsonObject {
          put("action", JsonPrimitive("capture"))
          put("deviceId", JsonPrimitive(deviceId))
          if (snapshotName != null) put("snapshotName", JsonPrimitive(snapshotName))
        }
      )
    return DeviceSnapshotCaptureResult(
      snapshotName =
        response.snapshotName ?: throw McpConnectionException("Capture returned no snapshotName"),
      snapshotType = response.snapshotType.orEmpty(),
      evictedSnapshotNames = response.evictedSnapshotNames,
    )
  }

  override fun restoreSnapshot(deviceId: String, snapshotName: String) {
    callSnapshotTool(
      buildJsonObject {
        put("action", JsonPrimitive("restore"))
        put("deviceId", JsonPrimitive(deviceId))
        // Required by the tool schema for restore; capture treats it as optional.
        put("snapshotName", JsonPrimitive(snapshotName))
      }
    )
  }

  private fun callSnapshotTool(arguments: JsonObject): DeviceSnapshotToolResponse {
    client.enableToolCapability("screen-artifacts")
    return decodeToolResponse(
      snapshotJson,
      client.callTool("deviceSnapshot", arguments),
      serializer<DeviceSnapshotToolResponse>(),
    )
  }
}

@Serializable
internal data class DeviceSnapshotToolResponse(
  val message: String? = null,
  val snapshotName: String? = null,
  val snapshotType: String? = null,
  val deviceId: String? = null,
  val deviceName: String? = null,
  // Omitted by the daemon when nothing was evicted.
  val evictedSnapshotNames: List<String> = emptyList(),
)

/** In-memory [DeviceSnapshotActions] for previews and tests. */
class FakeDeviceSnapshotActions(
  initialSnapshots: List<DeviceSnapshotMetadata> = emptyList(),
  private val evictOnCapture: List<String> = emptyList(),
) : DeviceSnapshotActions {
  private val snapshots = initialSnapshots.toMutableList()

  var restoredSnapshotName: String? = null
    private set

  override fun listSnapshots(): List<DeviceSnapshotMetadata> = snapshots.toList()

  override fun captureSnapshot(
    deviceId: String,
    snapshotName: String?,
  ): DeviceSnapshotCaptureResult {
    val name = snapshotName ?: "snapshot-${snapshots.size + 1}"
    snapshots.add(
      DeviceSnapshotMetadata(snapshotName = name, deviceId = deviceId, snapshotType = "full")
    )
    snapshots.removeAll { it.snapshotName in evictOnCapture }
    return DeviceSnapshotCaptureResult(name, "full", evictOnCapture)
  }

  override fun restoreSnapshot(deviceId: String, snapshotName: String) {
    if (snapshots.none { it.snapshotName == snapshotName }) {
      throw McpConnectionException("Snapshot '$snapshotName' not found")
    }
    restoredSnapshotName = snapshotName
  }
}
