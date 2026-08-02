package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.rememberLiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState

/**
 * Live device mirror for a workspace pane's stream area: subscribes to the daemon's video-stream
 * relay for this pane's device and draws the newest decoded frame, aspect-fit. Until a frame
 * arrives (or when the relay is refused/unavailable) a one-line status hint renders instead, so a
 * daemon without the relay degrades to a quiet placeholder rather than an error wall.
 *
 * One source lives per pane, keyed by deviceId: [rememberLiveVideoFrame] connects it on entry and
 * disposes it when the pane leaves the composition, so closing a column or flipping it to Inspect
 * mode tears the relay subscription down.
 *
 * [sessionUuidProvider] authenticates the subscribe against the stream-socket session guard
 * (#4751): the host supplies a provider from its `DesktopDaemonSession` (#4977). The workspace
 * session binds only the focused device, so this pane's subscribe passes either as the session's
 * own device or — for every other observed device — via the auth's unowned-device branch. When the
 * provider yields null (no session, or a non-Unix daemon) the subscribe is refused and the pane
 * shows the reason; the operator escape hatch remains `AUTOMOBILE_DAEMON_STREAM_AUTH=0`.
 *
 * [sourceFactory] is hoisted so tests inject a fake instead of opening a socket.
 */
@Composable
fun DeviceStreamView(
  column: DeviceColumn,
  sessionUuidProvider: () -> String? = { null },
  // Workspace panes default to the `low` preset (Android: long side capped at 540 + ~2 Mbps;
  // iOS: ~2 Mbps, resolution self-scales to Level 4.2): pane real estate can't show more pixels
  // than that anyway, and decode cost scales with pixel count, which is what makes dozens of
  // concurrent farm panes affordable. Hoisted so a host that wants a full-resolution mirror can
  // pass VideoStreamQuality.High or a different source entirely.
  sourceFactory: (deviceId: String) -> VideoStreamSource = {
    VideoStreamClient(quality = VideoStreamQuality.Low, sessionUuidProvider = sessionUuidProvider)
  },
) {
  val source = remember(column.deviceId) { sourceFactory(column.deviceId) }
  val liveFrame = rememberLiveVideoFrame(source, column.deviceId)
  val state by source.state.collectAsState()
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    val bitmap = liveFrame?.bitmap
    if (bitmap != null) {
      Image(
        bitmap = bitmap,
        contentDescription = "Live stream of ${column.name}",
        modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.Fit,
      )
    } else {
      Text(
        streamStatusHint(state),
        color = MaterialTheme.colorScheme.outline,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(12.dp),
      )
    }
  }
}

/**
 * One-line hint for a stream that has no frame on screen. `internal` (not `private`) so the
 * same-module pure test can pin the wording without composing the view.
 */
internal fun streamStatusHint(state: VideoStreamState): String =
  when (state) {
    is VideoStreamState.Idle -> "Live mirror idle"
    is VideoStreamState.Connecting -> "Connecting to live mirror…"
    // Streaming with no frame yet: the subscribe was accepted but nothing has decoded.
    is VideoStreamState.Streaming -> "Waiting for the first frame…"
    is VideoStreamState.Unavailable -> state.reason
  }
