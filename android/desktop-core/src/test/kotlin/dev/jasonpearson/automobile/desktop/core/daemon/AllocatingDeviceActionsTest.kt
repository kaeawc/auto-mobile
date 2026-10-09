package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * #10831: the IDE's Snapshots, Recording, Storage SQL, Take Screenshot and Appearance controls ran
 * under the desktop session without allocating the device, so the daemon refused them on every
 * device the user had not tapped first. They now allocate the device to the desktop session before
 * the call and run as that session; their reads still only watch.
 */
class AllocatingDeviceActionsTest {
  private val client = FakeAutoMobileClient()

  /** Each allocation, with how many tool calls had already been sent when it ran. */
  private val allocations = mutableListOf<String>()
  private var allowed = true
  private val allocation = DesktopInputAllocation { deviceId ->
    allocations += "$deviceId@${client.toolCalls.size}"
    allowed
  }

  private val provider =
    allocatingClientProvider(
      { client },
      allocation = { allocation },
      sessionUuidProvider = { DESKTOP_SESSION },
    )!!

  private fun toolResponse(bodyJson: String): JsonElement = buildJsonObject {
    put(
      "content",
      buildJsonArray {
        add(
          buildJsonObject {
            put("type", "text")
            put("text", bodyJson)
          },
        )
      },
    )
  }

  private fun sessionOf(call: FakeAutoMobileClient.ToolCall): String? =
    (call.arguments["sessionUuid"] as? JsonPrimitive)?.content

  @Test
  fun `a snapshot capture with no prior tap allocates the device, then runs as the desktop session`() {
    client.callToolResult =
      toolResponse("""{"snapshotName":"s1","snapshotType":"app","deviceId":"emulator-5554"}""")

    McpDeviceSnapshotActions(provider).captureSnapshot("emulator-5554", "s1")

    // setToolEnabled names no device and is not allocated; the capture is, before it is sent.
    assertEquals(listOf("setToolEnabled", "deviceSnapshot"), client.toolCalls.map { it.name })
    assertEquals(listOf("emulator-5554@1"), allocations)
    assertEquals(DESKTOP_SESSION, sessionOf(client.toolCalls[1]))
  }

  @Test
  fun `a recording start allocates the device before the tool call`() {
    client.callToolResult = toolResponse("""{"action":"start","count":0,"recordings":[]}""")

    McpVideoRecordingActions(provider).startRecording("emulator-5554")

    assertEquals(listOf("setToolEnabled", "videoRecording"), client.toolCalls.map { it.name })
    assertEquals(listOf("emulator-5554@1"), allocations)
    assertEquals(DESKTOP_SESSION, sessionOf(client.toolCalls[1]))
  }

  @Test
  fun `a refused allocation drops the capture instead of sending it under a session that holds nothing`() {
    allowed = false
    client.callToolResult =
      toolResponse("""{"snapshotName":"s1","snapshotType":"app","deviceId":"emulator-5554"}""")

    assertFailsWith<McpConnectionException> {
      McpDeviceSnapshotActions(provider).captureSnapshot("emulator-5554", "s1")
    }
    assertEquals(listOf("setToolEnabled"), client.toolCalls.map { it.name })
  }

  @Test
  fun `listing snapshots is a read and never allocates`() {
    client.setResourceResponseWithText(
      DEVICE_SNAPSHOT_ARCHIVE_URI,
      """{"snapshots":[],"count":0,"totalSizeBytes":0}""",
    )

    McpDeviceSnapshotActions(provider).listSnapshots()

    assertTrue(allocations.isEmpty())
  }

  @Test
  fun `take screenshot runs observe on the selected device without allocating or naming a session`() {
    provider().callTool("observe", screenshotObserveArguments("emulator-5554", "android"))

    val call = client.toolCalls.single()
    assertEquals("observe", call.name)
    assertEquals("emulator-5554", (call.arguments["deviceId"] as JsonPrimitive).content)
    assertEquals("android", (call.arguments["platform"] as JsonPrimitive).content)
    assertTrue(allocations.isEmpty())
    assertNull(sessionOf(call))
  }

  private fun sql(query: String) = buildJsonObject {
    put("deviceId", "emulator-5554")
    put("databasePath", "app.db")
    put("query", query)
  }

  @Test
  fun `a SELECT query only watches`() {
    listOf("SELECT * FROM t", "  -- c\n select 1;", "WITH a AS (SELECT 1) SELECT * FROM a")
      .forEach {
        provider().callTool("sqlQuery", sql(it))
      }

    assertTrue(allocations.isEmpty())
    assertTrue(client.toolCalls.all { sessionOf(it) == null })
  }

  @Test
  fun `write and unrecognized queries allocate first and run as the desktop session`() {
    listOf(
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "SELECT 1; DELETE FROM t",
        "WITH a AS (SELECT 1) DELETE FROM t",
        "PRAGMA user_version = 3",
        "VACUUM",
      )
      .forEach { provider().callTool("sqlQuery", sql(it)) }

    assertEquals(6, allocations.size)
    assertTrue(client.toolCalls.all { sessionOf(it) == DESKTOP_SESSION })
  }

  @Test
  fun `a refused allocation still drops a write query`() {
    allowed = false

    assertFailsWith<McpConnectionException> {
      provider().callTool("sqlQuery", sql("DELETE FROM t"))
    }
    assertTrue(client.toolCalls.isEmpty())
  }

  @Test
  fun `no client provider means no device-acting client`() {
    assertNull(allocatingClientProvider(null, { allocation }, { DESKTOP_SESSION }))
  }

  // -- Appearance --

  private class RecordingAppearanceClient(private val log: MutableList<String>) : AppearanceClient {
    override fun getConfig(): AppearanceResult {
      log += "getConfig"
      return AppearanceResult(AppearanceConfig())
    }

    override fun setSyncWithHost(enabled: Boolean): AppearanceResult {
      log += "setSyncWithHost"
      return AppearanceResult(AppearanceConfig(syncWithHost = enabled))
    }

    override fun setMode(mode: AppearanceSyncMode): AppearanceResult {
      log += "setMode:${mode.wireName}"
      return AppearanceResult(
        AppearanceConfig(defaultMode = mode.wireName),
        AppearanceSyncMode.Dark,
      )
    }

    override fun isAvailable(): Boolean = true
  }

  private val appearanceLog = mutableListOf<String>()
  private var selectedDevice: String? = "emulator-5554"
  private val appearance =
    AllocatingAppearanceClient(
      RecordingAppearanceClient(appearanceLog),
      allocation = {
        DesktopInputAllocation { deviceId ->
          appearanceLog += "allocate:$deviceId"
          allowed
        }
      },
      activeDeviceId = { selectedDevice },
    )

  @Test
  fun `an appearance change allocates the selected device first`() {
    appearance.setMode(AppearanceSyncMode.Dark)
    appearance.setSyncWithHost(true)

    assertEquals(
      listOf("allocate:emulator-5554", "setMode:dark", "allocate:emulator-5554", "setSyncWithHost"),
      appearanceLog,
    )
  }

  @Test
  fun `reading the appearance config never allocates`() {
    appearance.getConfig()

    assertEquals(listOf("getConfig"), appearanceLog)
  }

  @Test
  fun `a refused allocation does not send the appearance change`() {
    allowed = false

    assertFailsWith<McpConnectionException> { appearance.setMode(AppearanceSyncMode.Light) }
    assertEquals(listOf("allocate:emulator-5554"), appearanceLog)
  }

  @Test
  fun `with no selected device the change goes straight to the daemon`() {
    selectedDevice = null

    appearance.setMode(AppearanceSyncMode.Light)

    assertEquals(listOf("setMode:light"), appearanceLog)
  }

  private companion object {
    const val DESKTOP_SESSION = "desktop-session-d"
  }
}
