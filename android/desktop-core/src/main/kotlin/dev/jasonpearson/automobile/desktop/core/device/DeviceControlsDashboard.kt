package dev.jasonpearson.automobile.desktop.core.device

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.ActiveRecordingTracker
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceClient
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceConfig
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceSyncMode
import dev.jasonpearson.automobile.desktop.core.daemon.SessionReleaseReason
import dev.jasonpearson.automobile.desktop.core.daemon.TrackedRecording
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingArtifact
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfig
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingStartResult
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamDescriptor
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.Dispatchers

private val LOG = LoggerFactory.getLogger("DeviceControlsDashboard")

/**
 * The device the session released, and why (#11366): selecting another device is such a release.
 */
data class DeviceRelease(val deviceId: String, val reason: SessionReleaseReason? = null)

/**
 * Device appearance, video recording, and screen sharing.
 *
 * Appearance is a stored daemon setting, not a per-device toggle: `appearance.sock` takes no device
 * id, saves the mode, and applies it only to the devices this session controls (#10831). A change
 * takes control of the selected device first so it reaches that device. Recording is per-device and
 * spans two transports -- the start/stop verbs are MCP tool calls, while quality and retention live
 * on `video-recording.sock`.
 *
 * Screen sharing starts the daemon's WebRTC publisher, which pushes the device's screen to a
 * coordination server for browsers and CI dashboards to watch over WHEP. There is deliberately no
 * preview here: the daemon publishes rather than serves, so there is no local playback URL. Local
 * live mirroring is a separate socket entirely.
 */
@Composable
fun DeviceControlsDashboard(
  activeDeviceId: String?,
  modifier: Modifier = Modifier,
  activeRecordings: ActiveRecordingTracker = remember { ActiveRecordingTracker() },
  release: DeviceRelease? = null,
  options: DeviceControlsClients,
) {
  val memory = rememberDeviceControlsMemory()
  with(memory) {
    return with(options) {
      val colors = SharedTheme.globalColors
      val scope = rememberCoroutineScope()

      val recording = activeRecordings.current

      LoadStreams(memory)

      LoadDeviceConfiguration(memory)

      val run: (String, suspend () -> String?) -> Unit = { label, block ->
        runDeviceAction(memory, scope, label, block)
      }

      // Stops by recording id, which needs no device, so it never allocates one and still works
      // after
      // the device was released or the selection moved. The tracker is cleared whatever the
      // outcome:
      // a failed stop must not leave the button stuck on "Stop" (#10978).
      val finishRecording: suspend (TrackedRecording, String) -> String = { tracked, outcome ->
        finishDeviceRecording(memory, activeRecordings, tracked, outcome)
      }

      // The session released the recorded device: the daemon already stopped and finalized the
      // recording, so show it as stopped by the release and offer its artifact. Selecting another
      // device is such a release too (owner decision 2026-10-10, #11366).
      LaunchedEffect(release) {
        val tracked = activeRecordings.current
        if (release != null && tracked != null && tracked.deviceId == release.deviceId) {
          val outcome =
            if (release.reason == SessionReleaseReason.DEVICE_SWITCH) "Stopped by device switch"
            else "Stopped by release"
          run("Fetch recording") { finishRecording(tracked, outcome) }
        }
      }

      Column(
        modifier = modifier.fillMaxSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        AppearanceControls(memory, run)
        RecordingControls(memory, activeDeviceId, activeRecordings, run, finishRecording)
        notice?.let { Hint(it, Color(0xFF4CAF50)) }
        error?.let { Hint(it, Color(0xFFE53935)) }
        SharingControls(memory, activeDeviceId, run)
        manifestPath?.let {
          Hint("Segment manifest: $it", colors.text.normal.copy(alpha = 0.6f))
        }

        RecordingArtifacts()
      }
    }
  }
}

@Composable
private fun Chip(label: String, accent: Color, enabled: Boolean = true, onClick: () -> Unit) {
  val alpha = if (enabled) 1f else 0.4f
  Box(
    modifier =
      Modifier.background(accent.copy(alpha = 0.15f * alpha), RoundedCornerShape(4.dp))
        .let {
          if (enabled) it.clickable(onClick = onClick).pointerHoverIcon(PointerIcon.Hand) else it
        }
        .padding(horizontal = 8.dp, vertical = 3.dp),
  ) {
    Text(label, fontSize = 9.sp, softWrap = false, color = accent.copy(alpha = alpha))
  }
}

@Composable
private fun Hint(text: String, color: Color) {
  Text(text, fontSize = 10.sp, color = color.copy(alpha = 0.8f))
}

data class DeviceControlsClients(
  val appearanceClient: AppearanceClient?,
  val recordingActions: VideoRecordingActions?,
  val recordingConfigClient: VideoRecordingConfigClient?,
  val streamClient: WebRtcStreamClient?,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
)

internal data class DeviceControlsMemory(
  private val appearanceState: androidx.compose.runtime.MutableState<AppearanceConfig?>,
  private val appliedModeState: androidx.compose.runtime.MutableState<AppearanceSyncMode?>,
  private val recordingConfigState: androidx.compose.runtime.MutableState<VideoRecordingConfig?>,
  private val artifactsState: androidx.compose.runtime.MutableState<List<VideoRecordingArtifact>>,
  private val manifestPathState: androidx.compose.runtime.MutableState<String?>,
  private val busyState: androidx.compose.runtime.MutableState<Boolean>,
  private val noticeState: androidx.compose.runtime.MutableState<String?>,
  private val errorState: androidx.compose.runtime.MutableState<String?>,
  private val streamsState: androidx.compose.runtime.MutableState<List<WebRtcStreamDescriptor>>,
) {
  var appearance by appearanceState
  var appliedMode by appliedModeState
  var recordingConfig by recordingConfigState
  var artifacts by artifactsState
  var manifestPath by manifestPathState
  var busy by busyState
  var notice by noticeState
  var error by errorState
  var streams by streamsState
}

@Composable
private fun DeviceControlsClients.AppearanceControls(
  memory: DeviceControlsMemory,
  run: (String, suspend () -> String?) -> Unit,
) {
  val colors = SharedTheme.globalColors
  with(memory) {
    // -- Appearance --
    Text(
      "Appearance",
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal,
    )

    if (appearanceClient == null || appearance == null) {
      Hint("Appearance control is unavailable on this daemon.", colors.text.normal)
    } else {
      Text(
        "Applies to the devices this session controls; changing it takes control of the " +
          "selected device.",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AppearanceSyncMode.entries.forEach { mode ->
          val selected = appearance?.defaultMode == mode.wireName
          Chip(
            label = mode.wireName.replaceFirstChar { it.uppercase() },
            accent = if (selected) Color(0xFF4CAF50) else Color(0xFF9E9E9E),
            enabled = !busy,
          ) {
            run("Set appearance") {
              val result = appearanceClient.setMode(mode)
              appearance = result.config
              appliedMode = result.appliedMode
              if (result.appliedMode == null) {
                // The daemon omits appliedMode when this session controls no device; saying
                // "applied" would be a lie.
                "Saved ${mode.wireName} — this session controls no device to apply it to yet"
              } else {
                "Applied ${result.appliedMode.wireName}"
              }
            }
          }
        }
      }
      appearance?.let { current ->
        Text(
          "Follows host: ${if (current.syncWithHost) "yes" else "no"}" +
            (appliedMode?.let { " · currently ${it.wireName}" } ?: ""),
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.6f),
        )
        if (!current.syncWithHost && current.defaultMode != AppearanceSyncMode.Auto.wireName) {
          // Choosing an explicit mode is what turned host sync off -- make that visible rather
          // than letting it look like an unrelated setting changed itself.
          Hint(
            "Choosing light or dark turns off host sync. Pick Auto to follow the host again.",
            colors.text.normal.copy(alpha = 0.6f),
          )
        }
      }
    }
  }
}

@Composable
private fun DeviceControlsClients.RecordingControls(
  memory: DeviceControlsMemory,
  activeDeviceId: String?,
  activeRecordings: ActiveRecordingTracker,
  run: (String, suspend () -> String?) -> Unit,
  finishRecording: suspend (TrackedRecording, String) -> String,
) {
  val colors = SharedTheme.globalColors
  val recording = activeRecordings.current
  with(memory) {
    // -- Recording --
    Text(
      "Video recording",
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal,
    )

    if (activeDeviceId == null) {
      Hint("Select a device to record.", colors.text.normal)
    }

    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      Chip(
        label = if (recording != null) "Stop" else "Record",
        accent = if (recording != null) Color(0xFFE53935) else Color(0xFF4CAF50),
        enabled =
          recordingActions != null && (recording != null || activeDeviceId != null) && !busy,
      ) {
        toggleRecording(
          recording,
          activeDeviceId,
          activeRecordings,
          RecordingControlActions(run, finishRecording),
        )
      }
    }

    if (recording != null) {
      Hint(
        "Recording ${recording.deviceId}. Selecting another device releases this one and stops " +
          "the recording.",
        colors.text.normal.copy(alpha = 0.6f),
      )
    }

    recordingConfig?.let { current ->
      Text(
        "${current.qualityPreset} · ${current.fps} fps · ${current.format} · archive budget " +
          "${current.maxArchiveSizeMb} MB" +
          (current.resolution?.let { " · ${it.width}x${it.height}" } ?: ""),
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
      )
    }
  }
}

@Composable
private fun DeviceControlsClients.SharingControls(
  memory: DeviceControlsMemory,
  activeDeviceId: String?,
  run: (String, suspend () -> String?) -> Unit,
) {
  val colors = SharedTheme.globalColors
  with(memory) {
    // -- Remote viewing --
    Text(
      "Remote viewing",
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal,
    )

    if (streamClient?.isAvailable() != true) {
      Hint("Screen sharing is unavailable on this daemon.", colors.text.normal)
    } else {
      Text(
        // The daemon publishes to a coordination server; viewers watch it there, not here. Saying
        // otherwise would imply this window is about to show the video.
        "Publishes this device's screen to the configured coordination server, " +
          "where browsers and CI dashboards can watch it.",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )

      val publishing = streams.isNotEmpty()
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Chip(
          label = if (publishing) "Stop sharing" else "Share screen",
          accent = if (publishing) Color(0xFFE53935) else Color(0xFF7E57C2),
          enabled = activeDeviceId != null && !busy,
        ) {
          val deviceId = activeDeviceId ?: return@Chip
          if (publishing) {
            run("Stop sharing") {
              streamClient.stopStream(streams.firstOrNull()?.streamId)
              streams = streamClient.listStreams()
              "Stopped sharing"
            }
          } else {
            run("Share screen") {
              val started = streamClient.startStream(deviceId)
              streams = streamClient.listStreams()
              "Sharing to ${started?.whipEndpoint ?: "the coordination server"}"
            }
          }
        }
      }

      streams.forEach { stream ->
        Text(
          "${stream.streamId} · ${stream.state} · ${stream.framesSent} frames sent" +
            (stream.whipEndpoint.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.6f),
        )
      }
    }
  }
}

@Composable
private fun DeviceControlsMemory.RecordingArtifacts() {
  val colors = SharedTheme.globalColors
  if (artifacts.isNotEmpty()) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      items(artifacts.sortedBy { it.segmentIndex }) { artifact ->
        Row(
          modifier =
            Modifier.fillMaxWidth()
              .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(4.dp))
              .padding(horizontal = 10.dp, vertical = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text(
              // A lone recording has no meaningful segment number to show.
              if (artifacts.size > 1) "Segment ${artifact.segmentIndex}" else artifact.recordingId,
              fontSize = 11.sp,
              color = colors.text.normal,
            )
            Text(
              artifact.filePath,
              fontSize = 9.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
            )
          }
        }
      }
    }
  }
}

private data class RecordingControlActions(
  val run: (String, suspend () -> String?) -> Unit,
  val finishRecording: suspend (TrackedRecording, String) -> String,
)

private fun DeviceControlsClients.toggleRecording(
  recording: TrackedRecording?,
  activeDeviceId: String?,
  activeRecordings: ActiveRecordingTracker,
  actions: RecordingControlActions,
) {
  with(actions) {
    if (recording != null) {
      run("Stop recording") { finishRecording(recording, "Stopped") }
    } else {
      val deviceId = activeDeviceId ?: return
      run("Start recording") {
        // The owner is the session the start named, not a registration-gated read here: a stop
        // after a rotation must still name it (#11366).
        val started = recordingActions?.startRecording(deviceId) ?: VideoRecordingStartResult()
        started.recordings.firstOrNull()?.let {
          activeRecordings.begin(
            TrackedRecording(deviceId, it.recordingId, started.ownerSessionUuid),
          )
        }
        "Recording…"
      }
    }
  }
}
