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
import kotlinx.serialization.serializer

/** Socket file the daemon binds for WebRTC stream control. */
internal const val WEBRTC_STREAM_SOCKET_FILE = "webrtc-stream.sock"

/** An ICE server the publisher uses to establish its outbound connection. */
@Serializable
data class WebRtcIceServer(
  val urls: String = "",
  val username: String? = null,
  val credential: String? = null,
)

/**
 * Readiness observations from the encoder/publisher path. Null counters and timestamps mean that
 * the corresponding producer has not initialized yet.
 */
@Serializable
data class WebRtcStreamReadiness(
  val lastEncodedFrameTimestampUs: Long? = null,
  val lastIdrTimestampUs: Long? = null,
  val idrRequestCount: Long? = null,
  val idrCompletionCount: Long? = null,
  val encodedAccessUnitCount: Long? = null,
  val publisherRtpPacketCount: Long? = null,
  val captureSourceState: String = "not_initialized",
  val lastSourceError: String? = null,
)

/**
 * State of one published stream.
 *
 * Note the counters are *send*-side: this describes the daemon publishing the device's screen to a
 * coordination server, not a stream being received here. There is no playback URL in this
 * descriptor -- see [WebRtcStreamClient] for why that matters.
 */
@Serializable
data class WebRtcStreamDescriptor(
  val streamId: String = "",
  val state: String = "",
  val whipEndpoint: String = "",
  /** WHIP resource URL for the active session, used to reconnect or tear down. */
  val resourceUrl: String? = null,
  val iceServers: List<WebRtcIceServer> = emptyList(),
  val framesSent: Long = 0,
  val packetsSent: Long = 0,
  val audioPacketsSent: Long = 0,
  val audioSamplesSent: Long = 0,
  val readiness: WebRtcStreamReadiness = WebRtcStreamReadiness(),
)

/**
 * Controls the daemon's WebRTC screen publishing.
 *
 * **This is a publish-control surface, not a video source.** The daemon captures the device's
 * screen and *publishes* it to an external coordination server over WHIP; viewers watch it from
 * that server over WHEP. The daemon never serves video back to a local client, and the descriptor
 * carries only the ingest endpoint -- there is no playback URL to subscribe to. So the desktop can
 * start, stop and monitor a stream, but rendering it here would mean round-tripping a local
 * device's screen through a remote server.
 *
 * Streaming is also inert unless the operator has configured `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT`;
 * [isAvailable] only reports whether the socket exists, not whether an endpoint is configured. A
 * `start` against an unconfigured daemon fails with the daemon's own message.
 */
interface WebRtcStreamClient {
  /** Begins publishing [deviceId]'s screen to the configured coordination server. */
  fun startStream(deviceId: String?, streamId: String? = null): WebRtcStreamDescriptor?

  fun stopStream(streamId: String? = null): WebRtcStreamDescriptor?

  /** Status of one stream, or null when [streamId] names nothing active. */
  fun streamStatus(streamId: String): WebRtcStreamDescriptor?

  fun listStreams(): List<WebRtcStreamDescriptor>

  /** True when the daemon exposes this socket; false on daemons that predate it. */
  fun isAvailable(): Boolean
}

/**
 * Client for `~/.auto-mobile/webrtc-stream.sock`. One request per connection.
 *
 * [sessionUuidProvider] supplies the daemon session UUID that authenticates each `start`/`stop`/
 * `status`/`list` request against the stream-socket session guard (issue #4751). It is resolved per
 * request so a session established after this client is constructed is still picked up. When it
 * returns null the `sessionUuid` field is omitted from the wire request (`DaemonJson` drops nulls);
 * the daemon then rejects the request unless it was started with `AUTOMOBILE_DAEMON_STREAM_AUTH=0`.
 * The default provider returns null for callers that do not own a session-bound desktop app run;
 * the desktop host supplies a provider from `DesktopDaemonSession` for Unix-daemon connections.
 */
class WebRtcStreamSocketClient(
  private val socketPathValue: String = AutoMobileSocketPaths.socketPath(WEBRTC_STREAM_SOCKET_FILE),
  private val json: Json = DaemonJson,
  private val sessionUuidProvider: () -> String? = { null },
) : WebRtcStreamClient {

  override fun isAvailable(): Boolean = Files.exists(File(socketPathValue).toPath())

  override fun startStream(deviceId: String?, streamId: String?): WebRtcStreamDescriptor? =
    send(request("start", deviceId = deviceId, streamId = streamId)).stream

  override fun stopStream(streamId: String?): WebRtcStreamDescriptor? =
    send(request("stop", streamId = streamId)).stream

  override fun streamStatus(streamId: String): WebRtcStreamDescriptor? =
    send(request("status", streamId = streamId)).stream

  override fun listStreams(): List<WebRtcStreamDescriptor> {
    val response = send(request("list"))
    // `status` without a streamId answers with action "list", so accept either field.
    return response.streams ?: listOfNotNull(response.stream)
  }

  private fun request(action: String, deviceId: String? = null, streamId: String? = null) =
    WebRtcStreamSocketRequest(
      id = UUID.randomUUID().toString(),
      action = action,
      sessionUuid = sessionUuidProvider(),
      deviceId = deviceId,
      streamId = streamId,
    )

  private fun send(request: WebRtcStreamSocketRequest): WebRtcStreamSocketResponse {
    ensureSocketExists()

    val address = UnixDomainSocketAddress.of(socketPathValue)
    SocketChannel.open(address).use { channel ->
      val reader =
        BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
      val writer =
        BufferedWriter(
          OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
        )

      writer.write(json.encodeToString(serializer<WebRtcStreamSocketRequest>(), request))
      writer.newLine()
      writer.flush()

      val line = reader.readLine() ?: throw McpConnectionException("WebRTC stream socket closed")
      val response = json.decodeFromString(serializer<WebRtcStreamSocketResponse>(), line)

      if (!response.success) {
        throw McpConnectionException(response.error ?: "WebRTC stream request failed")
      }
      return response
    }
  }

  private fun ensureSocketExists() {
    if (!isAvailable()) {
      throw McpConnectionException("WebRTC stream socket not found at $socketPathValue")
    }
  }
}

@Serializable
internal data class WebRtcStreamSocketRequest(
  val id: String,
  val action: String,
  /**
   * Daemon session UUID that authenticates this request against the stream-socket session guard
   * (issue #4751). Null is serialized as an omitted field by `DaemonJson`, matching a pre-#4751
   * daemon and the escape-hatch path; a non-null value must resolve to a live daemon session or the
   * daemon rejects the request. See issue #4924 for why the desktop cannot yet populate it.
   */
  val sessionUuid: String? = null,
  val deviceId: String? = null,
  val streamId: String? = null,
)

@Serializable
internal data class WebRtcStreamSocketResponse(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean = false,
  val action: String? = null,
  val stream: WebRtcStreamDescriptor? = null,
  val streams: List<WebRtcStreamDescriptor>? = null,
  val error: String? = null,
)

/** In-memory [WebRtcStreamClient] for previews and tests. */
class FakeWebRtcStreamClient(
  private val available: Boolean = true,
  /** When set, `start` fails with this message, mimicking an unconfigured WHIP endpoint. */
  private val startFailure: String? = null,
) : WebRtcStreamClient {
  private val streams = mutableMapOf<String, WebRtcStreamDescriptor>()

  override fun isAvailable(): Boolean = available

  override fun startStream(deviceId: String?, streamId: String?): WebRtcStreamDescriptor {
    startFailure?.let { throw McpConnectionException(it) }
    val id = streamId ?: "stream-${streams.size + 1}"
    val descriptor =
      WebRtcStreamDescriptor(
        streamId = id,
        state = "connected",
        whipEndpoint = "https://coord.example.com/whip",
        resourceUrl = "https://coord.example.com/whip/$id",
      )
    streams[id] = descriptor
    return descriptor
  }

  override fun stopStream(streamId: String?): WebRtcStreamDescriptor? {
    val id = streamId ?: streams.keys.firstOrNull() ?: return null
    return streams.remove(id)?.copy(state = "closed")
  }

  override fun streamStatus(streamId: String): WebRtcStreamDescriptor? = streams[streamId]

  override fun listStreams(): List<WebRtcStreamDescriptor> = streams.values.toList()
}
