package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import dev.jasonpearson.automobile.desktop.core.layout.DeviceScreenOptions
import dev.jasonpearson.automobile.desktop.core.layout.DeviceScreenView
import dev.jasonpearson.automobile.desktop.core.platform.ScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.video.LiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.QualityController
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode

@Composable
private fun DeviceStreamContent(options: DeviceStreamContentOptions) {
  val column = options.column
  val state = options.state
  val displayFrame = options.displayFrame
  val armedFrame = options.armedFrame
  val control = options.control
  val controlSnapshot = options.controlSnapshot
  val enableDeviceControl = options.enableDeviceControl
  val readOnly = options.readOnly
  val settingsLaunchFailure = options.settingsLaunchFailure
  val onSettingsLaunchFailure = options.onSettingsLaunchFailure
  val screenRecordingSettingsLauncher = options.screenRecordingSettingsLauncher
  val source = options.source

  val armed =
    if (
      controlArmed(
        enableDeviceControl,
        control != null,
        controlSnapshot != null,
        armedFrame != null,
        readOnly,
      )
    ) {
      ArmedStreamControl(
        requireNotNull(control) { "Armed video needs control" },
        requireNotNull(controlSnapshot) { "Armed video needs an interaction snapshot" },
        requireNotNull(armedFrame) { "Armed video needs a frame" },
      )
    } else null
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
  } else if (armed != null) {
    ArmedDeviceStream(column, armed)
  } else {
    PlainDeviceStream(column, state, displayFrame, source)
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

@Composable
private fun androidx.compose.foundation.layout.BoxScope.DeviceQualityOverlay(
  options: DeviceStreamOptions,
  presentation: StreamSurfaceState,
) {
  val qualityController = presentation.qualityController
  val currentQuality = presentation.currentQuality
  val state = presentation.state
  val column = options.column
  val settings = options.settings
  // Quality overlay: only on the focused pane (controller present) and never over the permission
  // surface (which owns the whole pane while the relay is refused). Collapsed by default so it
  // does
  // not intercept a tap on the interactive control surface; the user expands it to pick a preset.
  val qualityAllowed =
    state !is VideoStreamState.PermissionRequired &&
      state !is VideoStreamState.Unavailable &&
      state !is VideoStreamState.Ended
  if (qualityController != null && qualityAllowed) {
    val actualFps by qualityController.actualFps.collectAsState()
    var autoAdjust by
      remember(column.deviceId) { mutableStateOf(qualityController.autoAdjustEnabled) }
    var overlayExpanded by remember(column.deviceId) { mutableStateOf(false) }
    StreamQualityControls(
      state =
        StreamQualityState(
          currentQuality = currentQuality,
          actualFps = actualFps,
          autoAdjustEnabled = autoAdjust,
          expanded = overlayExpanded,
        ),
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

@Composable
private fun androidx.compose.foundation.layout.BoxScope.RetainedStreamBanner(
  options: DeviceStreamOptions,
  presentation: StreamSurfaceState,
) {
  val newestFrame = presentation.newestFrame
  val state = presentation.state
  val source = presentation.source
  val column = options.column
  retainedStreamStatus(newestFrame != null, state)?.let { status ->
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      modifier =
        Modifier.align(Alignment.BottomCenter)
          .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
          .padding(12.dp),
    ) {
      Text(
        status,
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
      )
      if (state is VideoStreamState.Ended) {
        Button(
          onClick = {
            source.disconnect()
            source.connect(column.deviceId)
          },
        ) {
          Text("Reconnect")
        }
      }
    }
  }
}

@Composable
internal fun DeviceStreamSurface(options: DeviceStreamOptions, presentation: StreamSurfaceState) {
  val column = options.column
  val control = options.control
  val enableDeviceControl = options.enableDeviceControl
  val screenRecordingSettingsLauncher = options.screenRecordingSettingsLauncher
  val source = presentation.source
  val state = presentation.state
  val newestFrame = presentation.newestFrame
  val armedFrame = presentation.armedFrame
  val readOnly = presentation.readOnly
  val controlSnapshot = control?.interactionSnapshot
  var settingsLaunchFailure by remember(column.deviceId) { mutableStateOf(false) }
  Box(Modifier.fillMaxSize()) {
    DeviceStreamContent(
      options =
        DeviceStreamContentOptions(
          column = column,
          state = state,
          displayFrame = newestFrame,
          armedFrame = armedFrame,
          control = control,
          controlSnapshot = controlSnapshot,
          enableDeviceControl = enableDeviceControl,
          readOnly = readOnly,
          settingsLaunchFailure = settingsLaunchFailure,
          onSettingsLaunchFailure = { settingsLaunchFailure = it },
          screenRecordingSettingsLauncher = screenRecordingSettingsLauncher,
          source = source,
        ),
    )
    RetainedStreamBanner(options, presentation)
    if (readOnly) {
      Text(
        "Read-only: another session now controls this device",
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.bodySmall,
        modifier =
          Modifier.align(Alignment.TopStart)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
            .padding(6.dp),
      )
    }
    DeviceQualityOverlay(options, presentation)
  }
}

@Composable
private fun ArmedDeviceStream(column: DeviceColumn, armed: ArmedStreamControl) {
  val control = armed.control
  val controlSnapshot = armed.snapshot
  val armedFrame = armed.frame

  // Armed WITH live video: the pane's pixels are ALWAYS the live H.264 mirror — never the
  // observation screenshot. The armed surface requires [armedFrame]: a decoded frame from a
  // Streaming relay, or a retained frame within the control-freshness window (so a quality-step
  // re-subscribe or a momentary drop does not flicker the interactive surface away). Once the
  // window lapses with no frame, control DISARMS while the mirror below keeps the last pixels —
  // a genuinely-stale frame must not stay clickable while untagged taps land on a device whose
  // UI may have moved (#5255).
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
    liveFrame = armedFrame.bitmap,
    // Tagged so tests can pin WHICH surface rendered (interactive video vs. hint/mirror).
    modifier = Modifier.fillMaxSize().testTag(DEVICE_CONTROL_SURFACE_TEST_TAG),
    options =
      DeviceScreenOptions(
        screenWidth = renderSnapshot?.deviceWidth ?: 0,
        screenHeight = renderSnapshot?.deviceHeight ?: 0,
        rotation = renderSnapshot?.rotation ?: 0,
        hierarchy = renderSnapshot?.hierarchy?.root,
        selectedElementId = null,
        hoveredElementId = null,
        onElementSelected = {},
        onElementHovered = {},
        elementMap = renderSnapshot?.hierarchy?.elementMap?.takeIf { it.isNotEmpty() },
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
        // Streaming (real-time) drag: a non-null handle means this drag streams live; null keeps
        // the
        // atomic onControlSwipe above (flag off / unsupported). See VideoInputDispatcher.
        onControlGestureStreamBegin = { snapshot, downPoint ->
          control.dispatcher.beginGestureStream(snapshot, downPoint)
        },
        onControlKey = { snapshot, stroke -> control.dispatcher.key(stroke) },
      ),
  )
}

@Composable
private fun PlainDeviceStream(
  column: DeviceColumn,
  state: VideoStreamState,
  displayFrame: LiveVideoFrame?,
  source: VideoStreamSource,
) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    val bitmap = displayFrame?.bitmap
    if (bitmap != null) {
      Image(
        bitmap = bitmap,
        contentDescription = "Live stream of ${column.name}",
        modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.Fit,
      )
    } else {
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
          streamStatusHint(state),
          color = MaterialTheme.colorScheme.outline,
          style = MaterialTheme.typography.bodySmall,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(12.dp),
        )
        if (state is VideoStreamState.Ended) {
          Button(
            onClick = {
              source.disconnect()
              source.connect(column.deviceId)
            },
          ) {
            Text("Reconnect")
          }
        }
      }
    }
  }
}

private data class DeviceStreamContentOptions(
  val column: DeviceColumn,
  val state: VideoStreamState,
  val displayFrame: LiveVideoFrame?,
  val armedFrame: LiveVideoFrame?,
  val control: WorkspaceDeviceControlState?,
  val controlSnapshot: DeviceFrameSnapshot?,
  val enableDeviceControl: Boolean,
  val readOnly: Boolean,
  val settingsLaunchFailure: Boolean,
  val onSettingsLaunchFailure: (Boolean) -> Unit,
  val screenRecordingSettingsLauncher: ScreenRecordingSettingsLauncher,
  val source: VideoStreamSource,
)

internal data class StreamSurfaceState(
  val source: VideoStreamSource,
  val state: VideoStreamState,
  val newestFrame: LiveVideoFrame?,
  val armedFrame: LiveVideoFrame?,
  val readOnly: Boolean,
  val qualityController: QualityController?,
  val currentQuality: VideoStreamQuality,
)

private data class ArmedStreamControl(
  val control: WorkspaceDeviceControlState,
  val snapshot: DeviceFrameSnapshot,
  val frame: LiveVideoFrame,
)
