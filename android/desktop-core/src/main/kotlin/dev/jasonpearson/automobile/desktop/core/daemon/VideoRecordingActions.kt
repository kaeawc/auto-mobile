package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

private val recordingJson = DaemonJson

/**
 * One recorded artifact.
 *
 * A long recording is split into segments past the platform's screenrecord cap; each segment is its
 * own artifact sharing a [sessionId], ordered by [segmentIndex].
 */
@Serializable
data class VideoRecordingArtifact(
  val recordingId: String = "",
  val filePath: String = "",
  val segmentIndex: Int = 0,
  val sessionId: String? = null,
)

/**
 * Outcome of stopping a recording.
 *
 * [segmented] distinguishes a multi-segment session from a plain single-file stop -- the daemon
 * only sets it on the segmented path. [manifestPath] points at the `segments.json` written beside
 * the first segment; it is absent when the manifest write failed, which the daemon treats as
 * best-effort rather than failing the stop.
 */
data class VideoRecordingStopResult(
  val recordings: List<VideoRecordingArtifact> = emptyList(),
  val segmented: Boolean = false,
  val manifestPath: String? = null,
) {
  /** Artifacts grouped into sessions, ordered by segment index within each session. */
  val sessions: Map<String, List<VideoRecordingArtifact>>
    get() =
      recordings
        .groupBy { it.sessionId ?: it.recordingId }
        .mapValues { (_, segments) -> segments.sortedBy { it.segmentIndex } }
}

/** Start/stop verbs for device video recording, which live on the MCP tool path. */
interface VideoRecordingActions {
  fun startRecording(deviceId: String): List<VideoRecordingArtifact>

  /** Stops [recordingId], or every active recording when null. */
  fun stopRecording(deviceId: String, recordingId: String? = null): VideoRecordingStopResult
}

/** [VideoRecordingActions] backed by the `videoRecording` MCP tool. */
class McpVideoRecordingActions(private val clientProvider: () -> AutoMobileClient) :
  VideoRecordingActions {
  private val client by lazy(clientProvider)

  override fun startRecording(deviceId: String): List<VideoRecordingArtifact> =
    call(
        buildJsonObject {
          put("action", JsonPrimitive("start"))
          put("deviceId", JsonPrimitive(deviceId))
        }
      )
      .recordings

  override fun stopRecording(deviceId: String, recordingId: String?): VideoRecordingStopResult {
    val response =
      call(
        buildJsonObject {
          put("action", JsonPrimitive("stop"))
          put("deviceId", JsonPrimitive(deviceId))
          if (recordingId != null) put("recordingId", JsonPrimitive(recordingId))
        }
      )
    return VideoRecordingStopResult(
      recordings = response.recordings,
      segmented = response.segmented,
      manifestPath = response.manifestPath,
    )
  }

  private fun call(arguments: JsonObject): VideoRecordingToolResponse {
    client.enableToolCapability("screen-artifacts")
    return decodeToolResponse(
      recordingJson,
      client.callTool("videoRecording", arguments),
      serializer<VideoRecordingToolResponse>(),
    )
  }
}

@Serializable
internal data class VideoRecordingToolResponse(
  val action: String = "",
  val count: Int = 0,
  val recordings: List<VideoRecordingArtifact> = emptyList(),
  // Only present on a segmented stop.
  val segmented: Boolean = false,
  // Best-effort; absent if the manifest could not be written.
  val manifestPath: String? = null,
)

/** In-memory [VideoRecordingActions] for previews and tests. */
class FakeVideoRecordingActions(
  /** Segments produced by the next stop; more than one mimics a long, split recording. */
  private val segmentsPerStop: Int = 1
) : VideoRecordingActions {
  private var active: String? = null

  val isRecording: Boolean
    get() = active != null

  override fun startRecording(deviceId: String): List<VideoRecordingArtifact> {
    val recordingId = "rec-${deviceId}-1"
    active = recordingId
    return listOf(VideoRecordingArtifact(recordingId, "/tmp/$recordingId.mp4", 0, recordingId))
  }

  override fun stopRecording(deviceId: String, recordingId: String?): VideoRecordingStopResult {
    val sessionId = recordingId ?: active ?: "rec-${deviceId}-1"
    active = null
    val segments =
      (0 until segmentsPerStop).map { index ->
        VideoRecordingArtifact(
          recordingId = if (index == 0) sessionId else "$sessionId-$index",
          filePath = "/tmp/$sessionId-$index.mp4",
          segmentIndex = index,
          sessionId = sessionId,
        )
      }
    return VideoRecordingStopResult(
      recordings = segments,
      segmented = segmentsPerStop > 1,
      manifestPath = if (segmentsPerStop > 1) "/tmp/segments.json" else null,
    )
  }
}
