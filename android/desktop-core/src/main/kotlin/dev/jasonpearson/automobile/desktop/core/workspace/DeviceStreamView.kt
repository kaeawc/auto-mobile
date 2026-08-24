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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.LIVE_STALL_RECONNECT_MS
import dev.jasonpearson.automobile.desktop.core.layout.DeviceScreenView
import dev.jasonpearson.automobile.desktop.core.platform.MacScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.platform.ScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.rememberLiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.video.LiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.QualityController
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
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

/** Test tag on the armed interactive-video surface, so tests can pin which branch rendered. */
internal const val DEVICE_CONTROL_SURFACE_TEST_TAG = "device-control-surface"

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
  // When present, the pane gains a quality overlay (manual Low/Medium/High selector, live FPS, and
  // an auto-adjust toggle) whose choice persists here across sessions. Null keeps today's fixed
  // per-mode preset with no overlay, so existing embeddings are unchanged.
  settings: SettingsProvider? = null,
  // Hoisted so a host or test can pass a different quality/rate or a fake source entirely. The
  // quality is passed in (rather than baked in) so the pane can re-subscribe when the selector or
  // auto-adjust changes it.
  sourceFactory: (deviceId: String, quality: VideoStreamQuality) -> VideoStreamSource =
    { deviceId, quality ->
      VideoStreamClient(
        quality = quality,
        fps = if (enableDeviceControl) CONTROL_PANE_FPS else MIRROR_PANE_FPS,
        sessionUuidProvider = sessionUuidProvider,
      )
    },
  screenRecordingSettingsLauncher: ScreenRecordingSettingsLauncher =
    MacScreenRecordingSettingsLauncher(),
) {
  // The pane's fixed per-mode preset when there's no controller: an armed (user-driven) pane wants
  // the sharpest High stream; unfocused farm mirrors stay on the cheap Low preset.
  val defaultQuality = if (enableDeviceControl) VideoStreamQuality.High else VideoStreamQuality.Low
  val paneFps = if (enableDeviceControl) CONTROL_PANE_FPS else MIRROR_PANE_FPS

  // Quality controls live only on the actively-driven (focused/armed) pane, never on the farm's
  // display-only mirrors: those stay the cheap fixed Low preset with no overlay, which is what
  // keeps
  // dozens of concurrent panes affordable (#5217) and uncluttered. With settings wired the focused
  // pane's per-device controller measures the live rate and (when auto-adjust is on) steps the
  // preset down on a sustained drop / back up once healthy. Only a MANUAL pick persists (the
  // seed for the next launch); automatic steps re-subscribe but are not written to the settings
  // file. Keyed on deviceId so switching devices starts fresh.
  val qualityController =
    if (enableDeviceControl) {
      settings?.let { s ->
        remember(column.deviceId) {
          QualityController(
            initialQuality = VideoStreamQuality.fromWire(s.streamQualityPreset) ?: defaultQuality,
            targetFps = paneFps,
            autoAdjustEnabled = s.streamQualityAutoAdjust,
            onManualSelection = { s.streamQualityPreset = it.wire },
          )
        }
      }
    } else {
      null
    }
  val currentQuality =
    if (qualityController != null) qualityController.quality.collectAsState().value
    else defaultQuality
  // The live video mirror always streams — it's what the user watches in both modes. Farm panes
  // auto-reconnect so a dropped relay heals instead of staying "stopped" until the pane is torn
  // down. Keyed on deviceId AND the current preset: a user-driven quality change (or an auto-adjust
  // step) re-subscribes with the new hint. That takes effect for a sole subscriber / the next fresh
  // subscribe; while a per-device capture is SHARED the daemon fixes its encode from the FIRST
  // subscriber's hint and ignores a re-subscriber's differing one (VideoStreamSocketServer.attach),
  // so truly reconfiguring a live shared capture needs server-side work (follow-up). When
  // [settings]
  // is null the preset is constant, so this keys on deviceId only — unchanged from before.
  // Keyed on deviceId, the current preset, AND paneFps: focus changes paneFps (10↔30) independently
  // of the preset, so without paneFps a pane that gains/loses focus without a preset change would
  // keep streaming at the old rate (a focused pane stuck at the farm 10fps, or an unfocused pane
  // still consuming 30fps). Re-subscribing on the change applies for a sole subscriber / the next
  // subscribe; a live shared capture keeps the first subscriber's encode (server follow-up).
  val source =
    remember(column.deviceId, currentQuality, paneFps) {
      sourceFactory(column.deviceId, currentQuality)
    }
  val liveFrame =
    rememberLiveVideoFrame(
      source,
      column.deviceId,
      autoReconnect = true,
      // The Streaming-stall reconnect is only valid for idle-heartbeat sources (Android). The iOS
      // capture drops idle buffers, so a healthy static screen makes no frame progress and must
      // NOT be reconnected; the first-frame deadline still catches a never-first-frame wedge.
      stallReconnectMs = if (column.platform == Platform.Android) LIVE_STALL_RECONNECT_MS else null,
    )
  val state by source.state.collectAsState()
  val controlSnapshot = control?.interactionSnapshot
  var settingsLaunchFailure by remember(column.deviceId) { mutableStateOf(false) }
  // Perf span T3: mark each newly rendered video frame so the tracer can time the first frame after
  // a tap (the visual-response latency). Cheap no-op unless a dispatched tap is pending. The same
  // frame arrival feeds the quality controller so its live-rate estimate (and any auto-adjust) is
  // driven by exactly the frames the pane renders.
  LaunchedEffect(liveFrame?.sequence) {
    if (liveFrame != null) {
      control?.tracer?.videoFrameRendered(column.deviceId)
      qualityController?.onFrame(liveFrame.receivedAtMs)
    }
  }
  Box(Modifier.fillMaxSize()) {
    DeviceStreamContent(
      column = column,
      state = state,
      liveFrame = liveFrame,
      control = control,
      controlSnapshot = controlSnapshot,
      enableDeviceControl = enableDeviceControl,
      settingsLaunchFailure = settingsLaunchFailure,
      onSettingsLaunchFailure = { settingsLaunchFailure = it },
      screenRecordingSettingsLauncher = screenRecordingSettingsLauncher,
      source = source,
    )
    // Quality overlay: only on the focused pane (controller present) and never over the permission
    // surface (which owns the whole pane while the relay is refused). Collapsed by default so it
    // does
    // not intercept a tap on the interactive control surface; the user expands it to pick a preset.
    if (qualityController != null && state !is VideoStreamState.PermissionRequired) {
      val actualFps by qualityController.actualFps.collectAsState()
      var autoAdjust by
        remember(column.deviceId) { mutableStateOf(qualityController.autoAdjustEnabled) }
      var overlayExpanded by remember(column.deviceId) { mutableStateOf(false) }
      StreamQualityControls(
        currentQuality = currentQuality,
        actualFps = actualFps,
        targetFps = qualityController.targetFps,
        autoAdjustEnabled = autoAdjust,
        expanded = overlayExpanded,
        onToggleExpanded = { overlayExpanded = !overlayExpanded },
        onSelectQuality = {
          qualityController.selectQuality(it)
          // Collapse after a pick so the panel stops covering the interactive surface.
          overlayExpanded = false
        },
        onToggleAutoAdjust = { enabled ->
          qualityController.autoAdjustEnabled = enabled
          // Non-null whenever the controller exists (both derive from the same settings), but the
          // `if (enableDeviceControl)` wrapper hides that from the smart-cast, so guard explicitly.
          settings?.streamQualityAutoAdjust = enabled
          autoAdjust = enabled
        },
        modifier = Modifier.align(Alignment.TopEnd).padding(6.dp),
      )
    }
  }
}

/**
 * The pane's video surface: permission gate, armed interactive video, or plain mirror/hint. Split
 * out of [DeviceStreamView] so the quality overlay can compose over it without duplicating the
 * branch selection.
 */
@Composable
private fun DeviceStreamContent(
  column: DeviceColumn,
  state: VideoStreamState,
  liveFrame: LiveVideoFrame?,
  control: WorkspaceDeviceControlState?,
  controlSnapshot: DeviceFrameSnapshot?,
  enableDeviceControl: Boolean,
  settingsLaunchFailure: Boolean,
  onSettingsLaunchFailure: (Boolean) -> Unit,
  screenRecordingSettingsLauncher: ScreenRecordingSettingsLauncher,
  source: VideoStreamSource,
) {
  if (state is VideoStreamState.PermissionRequired) {
    // iOS screen-recording permission gate: the relay refused the capture until the user approves
    // Screen Recording, so there is NO live video to drive. Check this BEFORE the armed branch: on
    // iOS the observation stream can still hand us a snapshot (arming the pane) while the video
    // relay is refused, and taking the armed branch there would render a frozen fallback screenshot
    // and swallow the approval UI, stranding the user with no way to recover. Android never reaches
    // PermissionRequired (no screen-recording gate), so this reorder does not change its behavior.
    ScreenRecordingPermissionSurface(
      approvalTarget = state.approvalTarget,
      settingsLaunchFailure = settingsLaunchFailure,
      onOpenSettings = {
        onSettingsLaunchFailure(screenRecordingSettingsLauncher.openScreenRecording().isFailure)
      },
      onRetry = {
        source.disconnect()
        source.connect(column.deviceId)
      },
    )
  } else if (
    enableDeviceControl &&
      control != null &&
      controlSnapshot != null &&
      liveFrame != null &&
      state is VideoStreamState.Streaming
  ) {
    // Armed WITH live video: the pane's pixels are ALWAYS the live H.264 mirror — never the
    // observation screenshot. The armed surface requires a decoded frame AND a currently-Streaming
    // relay: before the first frame the pane shows the status hint, and once the relay drops the
    // last frame is still RENDERED (mirror branch below) but control DISARMS — a retained-but-stale
    // frame must not stay clickable while untagged taps land on a device whose UI may have moved.
    // Clicks map through the in-memory observation snapshot (its real device dimensions);
    // video and observation cover the same screen at the same aspect ratio, so a click normalized
    // against the displayed video maps to the same device pixel. DeviceScreenView already renders
    // a live bitmap while mapping through separate device dims — its inspector-mode
    // configuration, reused here with Control mode so the click dispatches instead of selecting.
    val renderSnapshot = control.renderSnapshot
    DeviceScreenView(
      // Deliberately null: observation screenshots are for geometry/inspection, not pane pixels.
      // Passing them here is what made the pane visibly "switch over to screenshots" whenever the
      // relay dropped a frame source; the retained live frame now covers those windows.
      screenshotData = null,
      liveFrame = liveFrame.bitmap,
      screenWidth = renderSnapshot?.deviceWidth ?: 0,
      screenHeight = renderSnapshot?.deviceHeight ?: 0,
      rotation = renderSnapshot?.rotation ?: 0,
      hierarchy = renderSnapshot?.hierarchy?.root,
      selectedElementId = null,
      hoveredElementId = null,
      onElementSelected = {},
      onElementHovered = {},
      elementMap = renderSnapshot?.hierarchy?.elementMap?.takeIf { it.isNotEmpty() },
      // Tagged so tests can pin WHICH surface rendered (interactive video vs. hint/mirror).
      modifier = Modifier.fillMaxSize().testTag(DEVICE_CONTROL_SURFACE_TEST_TAG),
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
      // Streaming (real-time) drag: a non-null handle means this drag streams live; null keeps the
      // atomic onControlSwipe above (flag off / unsupported). See VideoInputDispatcher.
      onControlGestureStreamBegin = { snapshot, downPoint ->
        control.dispatcher.beginGestureStream(snapshot, downPoint)
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
