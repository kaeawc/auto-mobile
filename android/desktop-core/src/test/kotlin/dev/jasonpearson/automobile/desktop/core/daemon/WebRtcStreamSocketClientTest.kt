package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonPrimitive

/** Covers [WebRtcStreamSocketClient] against a real in-process Unix socket. */
class WebRtcStreamSocketClientTest {

  private val descriptorJson =
    """
    {
      "streamId": "stream-1",
      "state": "connected",
      "whipEndpoint": "https://coord.example.com/whip",
      "resourceUrl": "https://coord.example.com/whip/stream-1",
      "iceServers": [{"urls": "stun:stun.example.com:3478"}],
      "framesSent": 120,
      "packetsSent": 480,
      "audioPacketsSent": 0,
      "audioSamplesSent": 0,
      "readiness": {
        "lastEncodedFrameTimestampUs": 1000,
        "lastIdrTimestampUs": 900,
        "idrRequestCount": 2,
        "idrCompletionCount": 1,
        "encodedAccessUnitCount": 3,
        "publisherRtpPacketCount": 6,
        "captureSourceState": "running",
        "lastSourceError": null
      }
    }
    """

  /** The WebRTC socket answers with stream/streams at the top level, not under `result`. */
  private fun server(rawBodyJson: String, success: Boolean = true) =
    TestConfigSocketServer(
      responseType = "webrtc_stream_response",
      socketFileName = "webrtc-stream.sock",
      rawBodyJson = rawBodyJson,
      success = success,
    )

  @Test
  fun `start sends the action and device id`() {
    // The daemon returns stream/streams at the top level, not under `result`, so the harness's
    // result payload is unused here -- only the request assertions matter.
    server("""{"action":"start"}""").use { s ->
      runCatching {
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString())
          .startStream("emulator-5554")
      }

      val request = s.awaitRequest()
      assertEquals("start", request["action"]?.jsonPrimitive?.content)
      assertEquals("emulator-5554", request["deviceId"]?.jsonPrimitive?.content)
    }
  }

  @Test
  fun `start carries the session uuid the provider supplies`() {
    // #4751 stream-socket auth: a resolved daemon session UUID authenticates the request.
    server("""{"action":"start"}""").use { s ->
      runCatching {
        WebRtcStreamSocketClient(
            socketPathValue = s.socketPath.toString(),
            sessionUuidProvider = { "session-abc" },
          )
          .startStream("emulator-5554")
      }

      assertEquals("session-abc", s.awaitRequest()["sessionUuid"]?.jsonPrimitive?.content)
    }
  }

  @Test
  fun `start omits the session uuid when the provider returns null`() {
    // The default (no desktop session identity yet, issue #4924) must not send an empty field, so a
    // pre-#4751 daemon still accepts the request unchanged.
    server("""{"action":"start"}""").use { s ->
      runCatching {
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString())
          .startStream("emulator-5554")
      }

      assertTrue(!s.awaitRequest().containsKey("sessionUuid"))
    }
  }

  @Test
  fun `stop carries the stream id when one is given`() {
    server("""{"action":"start"}""").use { s ->
      runCatching {
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString()).stopStream("stream-1")
      }

      val request = s.awaitRequest()
      assertEquals("stop", request["action"]?.jsonPrimitive?.content)
      assertEquals("stream-1", request["streamId"]?.jsonPrimitive?.content)
    }
  }

  @Test
  fun `stop without a stream id omits the field`() {
    server("""{"action":"start"}""").use { s ->
      runCatching {
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString()).stopStream()
      }

      assertTrue(!s.awaitRequest().containsKey("streamId"))
    }
  }

  @Test
  fun `a descriptor is decoded from a start response`() {
    server("""{"action":"start","stream":$descriptorJson}""").use { s ->
      val stream =
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString())
          .startStream("emulator-5554")

      assertNotNull(stream)
      assertEquals("stream-1", stream.streamId)
      assertEquals("connected", stream.state)
      assertEquals("https://coord.example.com/whip", stream.whipEndpoint)
      assertEquals(120L, stream.framesSent)
      assertEquals("stun:stun.example.com:3478", stream.iceServers.single().urls)
      assertEquals(1000L, stream.readiness.lastEncodedFrameTimestampUs)
      assertEquals("running", stream.readiness.captureSourceState)
    }
  }

  @Test
  fun `list decodes every active stream`() {
    server("""{"action":"list","streams":[$descriptorJson]}""").use { s ->
      val streams =
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString()).listStreams()

      assertEquals(1, streams.size)
      assertEquals("stream-1", streams.single().streamId)
    }
  }

  @Test
  fun `list is empty when nothing is publishing`() {
    server("""{"action":"list","streams":[]}""").use { s ->
      assertTrue(
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString()).listStreams().isEmpty()
      )
    }
  }

  @Test
  fun `an unconfigured whip endpoint surfaces the daemon's message`() {
    // Streaming is inert unless AUTOMOBILE_WEBRTC_WHIP_ENDPOINT is set; the daemon says so.
    server(
        """{"error":"WebRTC streaming is not configured (AUTOMOBILE_WEBRTC_WHIP_ENDPOINT)"}""",
        success = false,
      )
      .use { s ->
        val failure =
          assertFailsWith<McpConnectionException> {
            WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString())
              .startStream("emulator-5554")
          }

        assertTrue(failure.message!!.contains("AUTOMOBILE_WEBRTC_WHIP_ENDPOINT"))
      }
  }

  @Test
  fun `status for an unknown stream surfaces the daemon's error`() {
    server("""{"error":"No active WebRTC stream with id ghost."}""", success = false).use { s ->
      assertFailsWith<McpConnectionException> {
        WebRtcStreamSocketClient(socketPathValue = s.socketPath.toString()).streamStatus("ghost")
      }
    }
  }

  @Test
  fun `a missing socket names the path`() {
    val client = WebRtcStreamSocketClient(socketPathValue = "/tmp/no-webrtc-am.sock")

    assertTrue(!client.isAvailable())
    assertTrue(
      assertFailsWith<McpConnectionException> { client.listStreams() }
        .message!!
        .contains("/tmp/no-webrtc-am.sock")
    )
  }

  @Test
  fun `the fake tracks start, list and stop`() {
    val client = FakeWebRtcStreamClient()

    val started = client.startStream("emulator-5554")
    assertEquals(listOf(started.streamId), client.listStreams().map { it.streamId })

    assertEquals("closed", client.stopStream(started.streamId)?.state)
    assertTrue(client.listStreams().isEmpty())
  }

  @Test
  fun `the fake can mimic an unconfigured daemon`() {
    val client = FakeWebRtcStreamClient(startFailure = "WebRTC streaming is not configured")

    assertFailsWith<McpConnectionException> { client.startStream("emulator-5554") }
  }

  @Test
  fun `stopping nothing returns null rather than throwing`() {
    assertNull(FakeWebRtcStreamClient().stopStream())
  }
}
