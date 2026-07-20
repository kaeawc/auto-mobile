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

/** Socket file the daemon binds for video-recording configuration. */
internal const val VIDEO_RECORDING_SOCKET_FILE = "video-recording.sock"

/** Encoding and retention defaults for device video recordings. */
@Serializable
data class VideoRecordingConfig(
  val qualityPreset: String = "medium",
  val targetBitrateKbps: Long = 0,
  val maxThroughputMbps: Double = 0.0,
  val fps: Int = 0,
  val maxArchiveSizeMb: Long = 0,
  val format: String = "mp4",
  val resolution: VideoResolution? = null,
)

@Serializable data class VideoResolution(val width: Int, val height: Int)

/** A partial config update; only non-null fields are sent. */
@Serializable
data class VideoRecordingConfigInput(
  val qualityPreset: String? = null,
  val targetBitrateKbps: Long? = null,
  val maxThroughputMbps: Double? = null,
  val fps: Int? = null,
  val maxArchiveSizeMb: Long? = null,
  val format: String? = null,
  val resolution: VideoResolution? = null,
)

/**
 * Result of a config read or write.
 *
 * [evictedRecordingIds] is only populated by a write that shrank the archive budget; the daemon
 * omits the field on reads and on writes that evicted nothing.
 */
data class VideoRecordingConfigResult(
  val config: VideoRecordingConfig,
  val evictedRecordingIds: List<String> = emptyList(),
)

/** Reads and writes the daemon's video-recording configuration. */
interface VideoRecordingConfigClient {
  fun getConfig(): VideoRecordingConfigResult

  fun setConfig(input: VideoRecordingConfigInput): VideoRecordingConfigResult

  /** True when the daemon exposes this socket; false on daemons that predate it. */
  fun isAvailable(): Boolean
}

/**
 * Client for `~/.auto-mobile/video-recording.sock`.
 *
 * A *config* socket: `config/get` and `config/set` only. Starting and stopping recordings is an MCP
 * tool action, exposed through [VideoRecordingActions].
 */
class VideoRecordingSocketClient(
  private val socketPathValue: String =
    AutoMobileSocketPaths.socketPath(VIDEO_RECORDING_SOCKET_FILE),
  private val json: Json = DaemonJson,
) : VideoRecordingConfigClient {

  override fun isAvailable(): Boolean = Files.exists(File(socketPathValue).toPath())

  override fun getConfig(): VideoRecordingConfigResult =
    send(VideoRecordingSocketRequest(id = UUID.randomUUID().toString(), method = "config/get"))

  override fun setConfig(input: VideoRecordingConfigInput): VideoRecordingConfigResult =
    send(
      VideoRecordingSocketRequest(
        id = UUID.randomUUID().toString(),
        method = "config/set",
        params = VideoRecordingSocketParams(config = input),
      )
    )

  private fun send(request: VideoRecordingSocketRequest): VideoRecordingConfigResult {
    ensureSocketExists()

    val address = UnixDomainSocketAddress.of(socketPathValue)
    SocketChannel.open(address).use { channel ->
      val reader =
        BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
      val writer =
        BufferedWriter(
          OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
        )

      writer.write(json.encodeToString(serializer<VideoRecordingSocketRequest>(), request))
      writer.newLine()
      writer.flush()

      val line = reader.readLine() ?: throw McpConnectionException("Video recording socket closed")
      val response = json.decodeFromString(serializer<VideoRecordingSocketResponse>(), line)

      if (!response.success) {
        throw McpConnectionException(response.error ?: "Video recording request failed")
      }
      val result =
        response.result ?: throw McpConnectionException("Video recording response missing result")

      return VideoRecordingConfigResult(
        config = result.config,
        evictedRecordingIds = result.evictedRecordingIds,
      )
    }
  }

  private fun ensureSocketExists() {
    if (!isAvailable()) {
      throw McpConnectionException("Video recording socket not found at $socketPathValue")
    }
  }
}

@Serializable
internal data class VideoRecordingSocketRequest(
  val id: String,
  val type: String = "video_recording_request",
  val method: String,
  val params: VideoRecordingSocketParams? = null,
)

@Serializable internal data class VideoRecordingSocketParams(val config: VideoRecordingConfigInput?)

@Serializable
internal data class VideoRecordingSocketResponse(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean = false,
  val result: VideoRecordingSocketResult? = null,
  val error: String? = null,
)

@Serializable
internal data class VideoRecordingSocketResult(
  val config: VideoRecordingConfig,
  // Absent on reads and on writes that evicted nothing.
  val evictedRecordingIds: List<String> = emptyList(),
)

/** In-memory [VideoRecordingConfigClient] for previews and tests. */
class FakeVideoRecordingConfigClient(
  initialConfig: VideoRecordingConfig = VideoRecordingConfig(),
  private val available: Boolean = true,
  private val evictOnSet: List<String> = emptyList(),
) : VideoRecordingConfigClient {
  var config: VideoRecordingConfig = initialConfig
    private set

  override fun isAvailable(): Boolean = available

  override fun getConfig(): VideoRecordingConfigResult = VideoRecordingConfigResult(config)

  override fun setConfig(input: VideoRecordingConfigInput): VideoRecordingConfigResult {
    config =
      config.copy(
        qualityPreset = input.qualityPreset ?: config.qualityPreset,
        targetBitrateKbps = input.targetBitrateKbps ?: config.targetBitrateKbps,
        maxThroughputMbps = input.maxThroughputMbps ?: config.maxThroughputMbps,
        fps = input.fps ?: config.fps,
        maxArchiveSizeMb = input.maxArchiveSizeMb ?: config.maxArchiveSizeMb,
        format = input.format ?: config.format,
        resolution = input.resolution ?: config.resolution,
      )
    return VideoRecordingConfigResult(config, evictOnSet)
  }
}
