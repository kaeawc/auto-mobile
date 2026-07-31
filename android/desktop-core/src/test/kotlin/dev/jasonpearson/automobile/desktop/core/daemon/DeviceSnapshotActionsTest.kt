package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Covers [McpDeviceSnapshotActions], the MCP-tool half of device snapshots.
 *
 * Capture/restore/list are not available on `device-snapshot.sock` -- that socket only carries
 * config -- so these go through the regular client's `tools/call` and `resources/read`.
 */
class DeviceSnapshotActionsTest {

  private val json = Json { ignoreUnknownKeys = true }

  /** Wraps tool result JSON the way the MCP tool response envelope does. */
  private fun toolResponse(bodyJson: String): JsonElement = buildJsonObject {
    put(
      "content",
      buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", bodyJson)
          }
        )
      },
    )
  }

  private fun actionsWith(client: FakeAutoMobileClient) = McpDeviceSnapshotActions { client }

  @Test
  fun `listSnapshots reads the archive resource`() {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      DEVICE_SNAPSHOT_ARCHIVE_URI,
      """
      {
        "snapshots": [
          {"snapshotName":"nightly","deviceId":"emulator-5554","deviceName":"Pixel",
           "platform":"android","snapshotType":"full","includeAppData":true,
           "includeSettings":true,"createdAt":"2026-07-19T00:00:00Z",
           "lastAccessedAt":"2026-07-19T01:00:00Z","sizeBytes":2048}
        ],
        "count": 1,
        "totalSizeBytes": 2048
      }
      """
        .trimIndent(),
    )

    val snapshots = actionsWith(client).listSnapshots()

    assertEquals(1, snapshots.size)
    assertTrue(client.toolCalls.isEmpty())
    assertEquals("nightly", snapshots.single().snapshotName)
    assertEquals("android", snapshots.single().platform)
    assertEquals(2048L, snapshots.single().sizeBytes)
  }

  @Test
  fun `listSnapshots is empty when nothing has been captured`() {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      DEVICE_SNAPSHOT_ARCHIVE_URI,
      """{"snapshots": [], "count": 0, "totalSizeBytes": 0}""",
    )

    assertTrue(actionsWith(client).listSnapshots().isEmpty())
  }

  @Test
  fun `an archive error surfaces rather than reading as an empty list`() {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      DEVICE_SNAPSHOT_ARCHIVE_URI,
      """{"error": "Failed to list snapshots: disk unreadable"}""",
    )

    val failure = assertFailsWith<McpConnectionException> { actionsWith(client).listSnapshots() }

    assertTrue(
      failure.message!!.contains("disk unreadable"),
      "should surface the daemon's reason: ${failure.message}",
    )
  }

  @Test
  fun `capture returns the assigned name and any evictions`() {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse(
        """
        {"message":"captured","snapshotName":"snap-1","snapshotType":"full",
         "evictedSnapshotNames":["old-1"]}
        """
          .trimIndent()
      )

    val result = actionsWith(client).captureSnapshot("emulator-5554")

    assertEquals("snap-1", result.snapshotName)
    assertEquals("full", result.snapshotType)
    assertEquals(listOf("old-1"), result.evictedSnapshotNames)
  }

  @Test
  fun `snapshot actions reuse the client across operations`() {
    val client = FakeAutoMobileClient()
    client.callToolResult = toolResponse("""{"snapshotName":"snap-1","snapshotType":"full"}""")
    var providerCalls = 0
    val actions = McpDeviceSnapshotActions {
      providerCalls += 1
      client
    }

    actions.captureSnapshot("emulator-5554")
    actions.restoreSnapshot("emulator-5554", "snap-1")

    assertEquals(1, providerCalls)
  }

  @Test
  fun `capture with no evictions defaults the list to empty`() {
    val client = FakeAutoMobileClient()
    client.callToolResult = toolResponse("""{"snapshotName":"snap-2","snapshotType":"vm"}""")

    assertTrue(actionsWith(client).captureSnapshot("emulator-5554").evictedSnapshotNames.isEmpty())
  }

  @Test
  fun `restore succeeds without requiring a snapshotName in the response`() {
    val client = FakeAutoMobileClient()
    client.callToolResult = toolResponse("""{"message":"restored"}""")

    actionsWith(client).restoreSnapshot("emulator-5554", "snap-1")

    assertTrue(client.calls.contains("callTool"))
  }

  @Test
  fun `the fake actions capture, list and restore coherently`() {
    val actions = FakeDeviceSnapshotActions()

    val captured = actions.captureSnapshot("emulator-5554", "manual")
    assertEquals("manual", captured.snapshotName)
    assertEquals(listOf("manual"), actions.listSnapshots().map { it.snapshotName })

    actions.restoreSnapshot("emulator-5554", "manual")
    assertEquals("manual", actions.restoredSnapshotName)
  }

  @Test
  fun `restoring an unknown snapshot fails in the fake too`() {
    val actions = FakeDeviceSnapshotActions()

    assertFailsWith<McpConnectionException> { actions.restoreSnapshot("emulator-5554", "ghost") }
  }

  @Test
  fun `the fake config client applies partial updates without clobbering other fields`() {
    val client =
      FakeDeviceSnapshotConfigClient(
        DeviceSnapshotConfig(includeAppData = true, maxArchiveSizeMb = 1024)
      )

    val result = client.setConfig(DeviceSnapshotConfigInput(maxArchiveSizeMb = 256))

    assertEquals(256L, result.config.maxArchiveSizeMb)
    assertEquals(true, result.config.includeAppData, "untouched fields should survive")
  }
}
