package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.layout.DeviceScreenView
import dev.jasonpearson.automobile.desktop.core.platform.MacScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.platform.ScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.rememberLiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode

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
// Frame-rate + quality hints the pane sends the relay on subscribe.
//
// An actively-CONTROLLED pane is one the user is driving, so it streams at [CONTROL_PANE_FPS] with
// the High preset for the tightest, sharpest tap→visible-response. A display-only mirror instead
// uses the cheap farm defaults — the Low preset (Android: long side ~540 + ~2 Mbps; a pane can't
// show more pixels than that anyway, and decode cost scales with pixel count) and [MIRROR_PANE_FPS]
// — which is what keeps dozens of concurrent farm panes affordable (#5217). Frames are decoupled
// from input dispatch (issue #3348), so the mirror rate only bounds how quickly a tap's visual
// result appears, never the tap itself. The relay validates the hint in [5, 60]; the first
// subscriber's hint fixes the shared per-device encode.
private const val CONTROL_PANE_FPS = 30
private const val MIRROR_PANE_FPS = 10

@Composable
fun DeviceStreamView(
  column: DeviceColumn,
  sessionUuidProvider: () -> String? = { null },
  // Device control (tap-to-input): when [control] is armed (a paired observation snapshot exists),
  // the pane stays a live video mirror but becomes clickable — a click is mapped through the
  // in-memory observation snapshot (device dims) and dispatched as a device tap with no
  // frameContext. The video keeps playing; only the coordinate mapping uses the snapshot.
  // Null/disabled ⇒ plain video mirror.
  enableDeviceControl: Boolean = false,
  control: WorkspaceDeviceControlState? = null,
  // Hoisted so a host or test can pass a different quality/rate or a fake source entirely.
  sourceFactory: (deviceId: String) -> VideoStreamSource = {
    if (enableDeviceControl) {
      VideoStreamClient(
        quality = VideoStreamQuality.High,
        fps = CONTROL_PANE_FPS,
        sessionUuidProvider = sessionUuidProvider,
      )
    } else {
      VideoStreamClient(
        quality = VideoStreamQuality.Low,
        fps = MIRROR_PANE_FPS,
        sessionUuidProvider = sessionUuidProvider,
      )
    }
  },
  screenRecordingSettingsLauncher: ScreenRecordingSettingsLauncher =
    MacScreenRecordingSettingsLauncher(),
) {
  // The live video mirror always streams — it's what the user watches in both modes. Farm panes
  // auto-reconnect so a dropped relay heals instead of staying "stopped" until the pane is torn
  // down. Keyed on deviceId ONLY (not enableDeviceControl): the rate/quality preset is fixed at
  // subscribe. Re-keying on control state to "downgrade" an unfocused pane doesn't reliably work —
  // the daemon's per-device capture is shared and its encode is fixed by the FIRST subscriber's
  // hint, so a fresh client that re-subscribes to a still-live capture has its new hint ignored
  // (VideoStreamSocketServer.attach). Changing an armed pane's live rate needs server-side capture
  // reconfiguration (follow-up); re-keying only added reconnect churn for no reliable effect.
  val source = remember(column.deviceId) { sourceFactory(column.deviceId) }
  val liveFrame = rememberLiveVideoFrame(source, column.deviceId, autoReconnect = true)
  val state by source.state.collectAsState()
  val controlSnapshot = control?.interactionSnapshot
  var settingsLaunchFailure by remember(column.deviceId) { mutableStateOf(false) }
  // Perf span T3: mark each newly rendered video frame so the tracer can time the first frame after
  // a tap (the visual-response latency). Cheap no-op unless a dispatched tap is pending.
  LaunchedEffect(liveFrame?.sequence) {
    if (liveFrame != null) control?.tracer?.videoFrameRendered(column.deviceId)
  }
  if (state is VideoStreamState.PermissionRequired) {
    // iOS screen-recording permission gate: the relay refused the capture until the user approves
    // Screen Recording, so there is NO live video to drive. Check this BEFORE the armed branch: on
    // iOS the observation stream can still hand us a snapshot (arming the pane) while the video
    // relay is refused, and taking the armed branch there would render a frozen fallback screenshot
    // and swallow the approval UI, stranding the user with no way to recover. Android never reaches
    // PermissionRequired (no screen-recording gate), so this reorder does not change its behavior.
    ScreenRecordingPermissionSurface(
      approvalTarget = (state as VideoStreamState.PermissionRequired).approvalTarget,
      settingsLaunchFailure = settingsLaunchFailure,
      onOpenSettings = {
        settingsLaunchFailure = screenRecordingSettingsLauncher.openScreenRecording().isFailure
      },
      onRetry = {
        source.disconnect()
        source.connect(column.deviceId)
      },
    )
  } else if (enableDeviceControl && controlSnapshot != null) {
    // Armed: keep the SMOOTH LIVE VIDEO on screen, but map clicks through the in-memory
    // observation
    // snapshot (its real device dimensions + frameContext). The video and the observation
    // screenshot
    // are the same screen at the same aspect ratio, so a click normalized against the displayed
    // video maps to the same device pixel. DeviceScreenView already renders a live bitmap while
    // mapping through separate device dims — that's exactly its inspector-mode configuration,
    // reused
    // here with Control mode so the click dispatches instead of selecting an element.
    val renderSnapshot = control.renderSnapshot
    DeviceScreenView(
      // Fallback pixels only until the first video frame decodes; liveFrame renders instead when
      // set.
      screenshotData = renderSnapshot?.screenshotData,
      liveFrame = liveFrame?.bitmap,
      screenWidth = renderSnapshot?.deviceWidth ?: 0,
      screenHeight = renderSnapshot?.deviceHeight ?: 0,
      rotation = renderSnapshot?.rotation ?: 0,
      hierarchy = renderSnapshot?.hierarchy?.root,
      selectedElementId = null,
      hoveredElementId = null,
      onElementSelected = {},
      onElementHovered = {},
      elementMap = renderSnapshot?.hierarchy?.elementMap?.takeIf { it.isNotEmpty() },
      modifier = Modifier.fillMaxSize(),
      controlMode = DeviceScreenControlMode.Control,
      controlSnapshot = controlSnapshot,
      // The view maps a click through `snapshot`'s geometry and hands back the device-mapped
      // `point`; the dispatcher sends it to the daemon input/tap helper off the UI thread with NO
      // frameContext, so it can never be rejected as stale (the wedge). Perf spans T0 (tap
      // initiated) and the frame-age baseline (`capturedAtMs`) are stamped here, at the click.
      onControlTap = { snapshot, point ->
        control.tracer.tapInitiated(column.deviceId, snapshot.capturedAtMs)
        control.dispatcher.tap(point)
      },
      onControlSwipe = { snapshot, start, end, durationMs ->
        control.dispatcher.swipe(snapshot, start, end, durationMs)
      },
      onControlKey = { snapshot, stroke -> control.dispatcher.key(stroke) },
    )
  } else {
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
}

@Composable
private fun ScreenRecordingPermissionSurface(
  approvalTarget: String,
  settingsLaunchFailure: Boolean,
  onOpenSettings: () -> Unit,
  onRetry: () -> Unit,
) {
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(8.dp),
    modifier = Modifier.padding(24.dp),
  ) {
    Text(
      "Screen Recording needs approval",
      style = MaterialTheme.typography.titleSmall,
    )
    Text(
      "Enable $approvalTarget in System Settings to discover and observe iOS Simulator windows.",
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      style = MaterialTheme.typography.bodySmall,
      textAlign = TextAlign.Center,
    )
    Text(
      "AutoMobile will check again automatically after approval.",
      color = MaterialTheme.colorScheme.outline,
      style = MaterialTheme.typography.bodySmall,
      textAlign = TextAlign.Center,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Button(onClick = onOpenSettings) {
        Text("Open System Settings")
      }
      OutlinedButton(onClick = onRetry) {
        Text("Check again")
      }
    }
    if (settingsLaunchFailure) {
      Text(
        "Open Privacy & Security > Screen Recording and enable $approvalTarget.",
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
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
    is VideoStreamState.PermissionRequired -> "Screen Recording needs approval"
    is VideoStreamState.Unavailable -> state.reason
  }
