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
import androidx.compose.runtime.mutableStateOf
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
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceClient
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceConfig
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceSyncMode
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingArtifact
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfig
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.WebRtcStreamDescriptor
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("DeviceControlsDashboard")

/**
 * Device appearance, video recording, and screen sharing.
 *
 * Appearance is a *global* control: `appearance.sock` takes no device id and applies to every
 * pooled device, so it is presented that way rather than as a per-device toggle. Recording is
 * per-device and spans two transports -- the start/stop verbs are MCP tool calls, while quality and
 * retention live on `video-recording.sock`.
 *
 * Screen sharing starts the daemon's WebRTC publisher, which pushes the device's screen to a
 * coordination server for browsers and CI dashboards to watch over WHEP. There is deliberately no
 * preview here: the daemon publishes rather than serves, so there is no local playback URL. Local
 * live mirroring is a separate socket entirely.
 */
@Composable
fun DeviceControlsDashboard(
  appearanceClient: AppearanceClient?,
  recordingActions: VideoRecordingActions?,
  recordingConfigClient: VideoRecordingConfigClient?,
  streamClient: WebRtcStreamClient?,
  activeDeviceId: String?,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val scope = rememberCoroutineScope()

  var appearance by remember { mutableStateOf<AppearanceConfig?>(null) }
  var appliedMode by remember { mutableStateOf<AppearanceSyncMode?>(null) }
  var recordingConfig by remember { mutableStateOf<VideoRecordingConfig?>(null) }
  var artifacts by remember { mutableStateOf<List<VideoRecordingArtifact>>(emptyList()) }
  var manifestPath by remember { mutableStateOf<String?>(null) }
  var isRecording by remember { mutableStateOf(false) }
  var busy by remember { mutableStateOf(false) }
  var notice by remember { mutableStateOf<String?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  var streams by remember { mutableStateOf<List<WebRtcStreamDescriptor>>(emptyList()) }

  LaunchedEffect(streamClient) {
    if (streamClient?.isAvailable() != true) return@LaunchedEffect
    streams =
      try {
        withContext(Dispatchers.IO) { streamClient.listStreams() }
      } catch (e: Exception) {
        LOG.warn("Could not list WebRTC streams: ${e.message}", e)
        emptyList()
      }
  }

  LaunchedEffect(appearanceClient, recordingConfigClient) {
    withContext(Dispatchers.IO) {
      appearance =
        try {
          if (appearanceClient?.isAvailable() == true) appearanceClient.getConfig().config else null
        } catch (e: Exception) {
          LOG.warn("Appearance config unavailable: ${e.message}", e)
          null
        }
      recordingConfig =
        try {
          if (recordingConfigClient?.isAvailable() == true) {
            recordingConfigClient.getConfig().config
          } else {
            null
          }
        } catch (e: Exception) {
          LOG.warn("Recording config unavailable: ${e.message}", e)
          null
        }
    }
  }

  fun run(label: String, block: suspend () -> String?) {
    busy = true
    notice = null
    error = null
    scope.launch {
      try {
        notice = withContext(Dispatchers.IO) { block() }
      } catch (e: Exception) {
        LOG.warn("$label failed: ${e.message}", e)
        error = e.message ?: "$label failed"
      } finally {
        busy = false
      }
    }
  }

  Column(
    modifier = modifier.fillMaxSize().padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
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
        "Applies to all connected devices.",
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
                // The daemon omits appliedMode when the device pool is empty; saying "applied"
                // would be a lie.
                "Saved ${mode.wireName} — no connected devices to apply it to yet"
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
        label = if (isRecording) "Stop" else "Record",
        accent = if (isRecording) Color(0xFFE53935) else Color(0xFF4CAF50),
        enabled = recordingActions != null && activeDeviceId != null && !busy,
      ) {
        val deviceId = activeDeviceId ?: return@Chip
        if (isRecording) {
          run("Stop recording") {
            val result = recordingActions?.stopRecording(deviceId)
            artifacts = result?.recordings.orEmpty()
            manifestPath = result?.manifestPath
            isRecording = false
            val count = artifacts.size
            if (result?.segmented == true) {
              "Stopped — $count segment(s) across ${result.sessions.size} session(s)"
            } else {
              "Stopped — $count recording(s)"
            }
          }
        } else {
          run("Start recording") {
            recordingActions?.startRecording(deviceId)
            isRecording = true
            "Recording…"
          }
        }
      }
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

    notice?.let { Hint(it, Color(0xFF4CAF50)) }
    error?.let { Hint(it, Color(0xFFE53935)) }
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

    manifestPath?.let {
      Hint("Segment manifest: $it", colors.text.normal.copy(alpha = 0.6f))
    }

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
                if (artifacts.size > 1) "Segment ${artifact.segmentIndex}"
                else artifact.recordingId,
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
        .padding(horizontal = 8.dp, vertical = 3.dp)
  ) {
    Text(label, fontSize = 9.sp, softWrap = false, color = accent.copy(alpha = alpha))
  }
}

@Composable
private fun Hint(text: String, color: Color) {
  Text(text, fontSize = 10.sp, color = color.copy(alpha = 0.8f))
}
