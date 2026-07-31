package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Covers the video-recording config socket and the MCP-tool start/stop verbs. */
class VideoRecordingClientTest {

  private val configJson =
    """
    {
      "qualityPreset": "high",
      "targetBitrateKbps": 8000,
      "maxThroughputMbps": 12.5,
      "fps": 60,
      "maxArchiveSizeMb": 2048,
      "format": "mp4",
      "resolution": {"width": 1080, "height": 2400}
    }
    """

  private fun server(resultJson: String? = null, error: String? = null) =
    TestConfigSocketServer(
      responseType = "video_recording_response",
      resultJson = resultJson,
      error = error,
      socketFileName = "video-recording.sock",
    )

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

  // -- config socket --

  @Test
  fun `config get decodes the full config including resolution`() {
    server(resultJson = """{"config": $configJson}""").use { s ->
      val result = VideoRecordingSocketClient(socketPathValue = s.socketPath.toString()).getConfig()

      assertEquals("high", result.config.qualityPreset)
      assertEquals(60, result.config.fps)
      assertEquals(12.5, result.config.maxThroughputMbps)
      assertEquals(VideoResolution(1080, 2400), result.config.resolution)
    }
  }

  @Test
  fun `config set sends only the changed field`() {
    server(resultJson = """{"config": $configJson}""").use { s ->
      VideoRecordingSocketClient(socketPathValue = s.socketPath.toString())
        .setConfig(VideoRecordingConfigInput(qualityPreset = "low"))

      val request = s.awaitRequest()
      assertEquals("config/set", request["method"]?.jsonPrimitive?.content)
      assertEquals("video_recording_request", request["type"]?.jsonPrimitive?.content)
      val config = request["params"]?.jsonObject?.get("config")?.jsonObject
      assertEquals("low", config?.get("qualityPreset")?.jsonPrimitive?.content)
      assertTrue(config?.containsKey("fps") != true, "untouched fields must be omitted")
    }
  }

  @Test
  fun `evicted recording ids are surfaced from a set`() {
    server(resultJson = """{"config": $configJson, "evictedRecordingIds": ["rec-1"]}""").use { s ->
      val result =
        VideoRecordingSocketClient(socketPathValue = s.socketPath.toString())
          .setConfig(VideoRecordingConfigInput(maxArchiveSizeMb = 10))

      assertEquals(listOf("rec-1"), result.evictedRecordingIds)
    }
  }

  @Test
  fun `an absent evicted list defaults to empty`() {
    server(resultJson = """{"config": $configJson}""").use { s ->
      assertTrue(
        VideoRecordingSocketClient(socketPathValue = s.socketPath.toString())
          .getConfig()
          .evictedRecordingIds
          .isEmpty()
      )
    }
  }

  @Test
  fun `a missing socket names the path`() {
    val client = VideoRecordingSocketClient(socketPathValue = "/tmp/no-video-am.sock")

    assertTrue(!client.isAvailable())
    assertTrue(
      assertFailsWith<McpConnectionException> { client.getConfig() }
        .message!!
        .contains("/tmp/no-video-am.sock")
    )
  }

  // -- MCP tool verbs --

  @Test
  fun `start returns the new recording`() {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse(
        """{"action":"start","count":1,"recordings":[{"recordingId":"rec-1","filePath":"/tmp/rec-1.mp4"}]}"""
      )

    val recordings = McpVideoRecordingActions { client }.startRecording("emulator-5554")

    assertEquals(1, recordings.size)
    assertEquals(listOf("setToolCapability", "videoRecording"), client.toolCalls.map { it.name })
    assertEquals(
      "screen-artifacts",
      client.toolCalls.first().arguments["capability"]?.jsonPrimitive?.content,
    )
    assertEquals("rec-1", recordings.single().recordingId)
  }

  @Test
  fun `video actions continue when an older daemon lacks capability controls`() {
    val delegate = FakeAutoMobileClient()
    delegate.callToolResult =
      toolResponse(
        """{"action":"start","count":1,"recordings":[{"recordingId":"rec-1","filePath":"/tmp/rec-1.mp4"}]}"""
      )
    val client =
      object : AutoMobileClient by delegate {
        override fun callTool(
          name: String,
          arguments: kotlinx.serialization.json.JsonObject,
        ): JsonElement {
          if (name == "setToolCapability") {
            throw McpConnectionException("Unknown tool: setToolCapability")
          }
          return delegate.callTool(name, arguments)
        }

        override fun enableToolCapability(capability: String) {
          super<AutoMobileClient>.enableToolCapability(capability)
        }
      }

    val recordings = McpVideoRecordingActions { client }.startRecording("emulator-5554")

    assertEquals("rec-1", recordings.single().recordingId)
    assertEquals(listOf("videoRecording"), delegate.toolCalls.map { it.name })
  }

  @Test
  fun `video actions reuse the client across operations`() {
    val client = FakeAutoMobileClient()
    client.callToolResult = toolResponse("""{"recordings":[]}""")
    var providerCalls = 0
    val actions = McpVideoRecordingActions {
      providerCalls += 1
      client
    }

    actions.startRecording("emulator-5554")
    actions.stopRecording("emulator-5554")

    assertEquals(1, providerCalls)
  }

  @Test
  fun `a plain stop is not marked segmented and has no manifest`() {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse(
        """{"action":"stop","count":1,"recordings":[{"recordingId":"rec-1","filePath":"/tmp/rec-1.mp4","segmentIndex":0}]}"""
      )

    val result = McpVideoRecordingActions { client }.stopRecording("emulator-5554", "rec-1")

    assertTrue(!result.segmented)
    assertNull(result.manifestPath)
    assertEquals(1, result.recordings.size)
  }

  @Test
  fun `a segmented stop keeps every segment and the manifest path`() {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse(
        """
        {"action":"stop","count":3,"manifestPath":"/tmp/a/segments.json","segmented":true,
         "recordings":[
           {"recordingId":"rec-1","filePath":"/tmp/a/0.mp4","segmentIndex":0,"sessionId":"rec-1"},
           {"recordingId":"rec-2","filePath":"/tmp/a/1.mp4","segmentIndex":1,"sessionId":"rec-1"},
           {"recordingId":"rec-3","filePath":"/tmp/a/2.mp4","segmentIndex":2,"sessionId":"rec-1"}
         ]}
        """
          .trimIndent()
      )

    val result = McpVideoRecordingActions { client }.stopRecording("emulator-5554")

    assertTrue(result.segmented)
    assertEquals("/tmp/a/segments.json", result.manifestPath)
    assertEquals(3, result.recordings.size)
  }

  @Test
  fun `segments group by session in index order`() {
    val result =
      VideoRecordingStopResult(
        recordings =
          listOf(
            VideoRecordingArtifact("rec-3", "/tmp/2.mp4", 2, "rec-1"),
            VideoRecordingArtifact("rec-1", "/tmp/0.mp4", 0, "rec-1"),
            VideoRecordingArtifact("rec-2", "/tmp/1.mp4", 1, "rec-1"),
          ),
        segmented = true,
      )

    val session = result.sessions.getValue("rec-1")

    assertEquals(listOf(0, 1, 2), session.map { it.segmentIndex }, "out-of-order input is sorted")
  }

  @Test
  fun `an artifact with no sessionId groups under its own recording id`() {
    // Non-segmented stops omit sessionId entirely.
    val result =
      VideoRecordingStopResult(listOf(VideoRecordingArtifact("rec-9", "/tmp/rec-9.mp4", 0, null)))

    assertEquals(setOf("rec-9"), result.sessions.keys)
  }

  @Test
  fun `a segmented stop may omit the manifest path when the write failed`() {
    val client = FakeAutoMobileClient()
    client.callToolResult =
      toolResponse(
        """{"action":"stop","count":1,"segmented":true,"recordings":[{"recordingId":"rec-1","filePath":"/tmp/0.mp4","segmentIndex":0,"sessionId":"rec-1"}]}"""
      )

    val result = McpVideoRecordingActions { client }.stopRecording("emulator-5554")

    assertTrue(result.segmented, "still a segmented session")
    assertNull(result.manifestPath, "manifest writing is best-effort")
  }

  @Test
  fun `the fake records a multi-segment session`() {
    val actions = FakeVideoRecordingActions(segmentsPerStop = 3)

    actions.startRecording("emulator-5554")
    assertTrue(actions.isRecording)

    val result = actions.stopRecording("emulator-5554")

    assertTrue(!actions.isRecording)
    assertTrue(result.segmented)
    assertEquals(3, result.sessions.values.single().size)
  }
}
