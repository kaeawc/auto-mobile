package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.layout.HierarchyUpdateOptions
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorState
import dev.jasonpearson.automobile.desktop.core.layout.ScreenshotUpdateOptions
import dev.jasonpearson.automobile.desktop.core.layout.computeChangedElements
import dev.jasonpearson.automobile.desktop.core.layout.parseHierarchyFromJson
import dev.jasonpearson.automobile.desktop.core.layout.updateConnectionStatus
import dev.jasonpearson.automobile.desktop.core.rememberControlFreshnessTick
import dev.jasonpearson.automobile.desktop.domain.ConnectionStatus
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import kotlinx.coroutines.withContext

@Composable
internal fun WorkspaceHierarchyCollector(
  options: WorkspaceDeviceControlOptions,
  stream: ObservationStream?,
  layoutState: LayoutInspectorState,
  session: DeviceControlSession,
) {
  with(options) {
    // Hierarchy collector — mirrors AutoMobileContent's Live Layout collector. The receipt-time
    // hooks
    // fire BEFORE the async parse so a scale/context flip invalidates control immediately; the
    // frame
    // generation is captured before the parse so a frame decoded across an invalidation is dropped.
    LaunchedEffect(stream, column.deviceId) {
      val active = stream ?: return@LaunchedEffect
      active.resetLayoutReplayCache()
      active.hierarchyUpdates.collect { update ->
        if (update.deviceId != column.deviceId) return@collect
        session.onObservationFrameContextDeclared(update.frameContext, update.captureSequence)
        session.onObservationSpaceDeclared(
          update.coordinateSpace,
          update.captureSequence,
          update.nativeScale,
        )
        val generation = layoutState.frameGeneration
        update.data?.let { hierarchyJson ->
          val result =
            withContext(ioDispatcher) {
              val parsed = parseHierarchyFromJson(hierarchyJson) ?: return@withContext null
              val changed =
                layoutState.computeChangedElements(layoutState.currentElementMap, parsed.elementMap)
              parsed to changed
            }
          result?.let {
            layoutState.updateConnectionStatus(ConnectionStatus.Connected)
            layoutState.applyHierarchyUpdate(
              parsed = it.first,
              changedIds = it.second,
              generation = generation,
              options =
                HierarchyUpdateOptions(
                  deviceId = update.deviceId,
                  captureSequence = update.captureSequence,
                  frameContext = update.frameContext,
                  coordinateSpace = update.coordinateSpace,
                  nativeScale = update.nativeScale,
                  captureRotation = update.rotation,
                ),
            )
          }
        }
      }
    }
  }
}

@Composable
internal fun WorkspaceScreenshotCollector(
  options: WorkspaceDeviceControlOptions,
  stream: ObservationStream?,
  layoutState: LayoutInspectorState,
  session: DeviceControlSession,
) {
  with(options) {
    // Screenshot collector — same receipt-time gate + generation guard; decodes the base64 frame
    // the
    // control surface renders and maps clicks against.
    LaunchedEffect(stream, column.deviceId) {
      val active = stream ?: return@LaunchedEffect
      active.resetLayoutReplayCache()
      active.screenshotUpdates.collect { update ->
        if (update.deviceId != column.deviceId) return@collect
        session.onObservationFrameContextDeclared(update.frameContext, update.captureSequence)
        session.onObservationSpaceDeclared(
          update.coordinateSpace,
          update.captureSequence,
          update.nativeScale,
        )
        val generation = layoutState.frameGeneration
        update.screenshotBase64?.let { base64 ->
          val data = withContext(ioDispatcher) { java.util.Base64.getDecoder().decode(base64) }
          layoutState.updateConnectionStatus(ConnectionStatus.Connected)
          layoutState.updateScreenshot(
            data = data,
            width = update.screenWidth,
            height = update.screenHeight,
            timestamp = update.timestamp,
            options =
              ScreenshotUpdateOptions(
                fallback = update.screenshotFallback ?: false,
                fallbackReason = update.screenshotFallbackReason,
                format = update.screenshotFormat,
                captureSource = update.screenshotCaptureSource,
                deviceId = update.deviceId,
                generation = generation,
                captureSequence = update.captureSequence,
                frameContext = update.frameContext,
                coordinateSpace = update.coordinateSpace,
                nativeScale = update.nativeScale,
                rotation = update.rotation,
              ),
          )
        }
      }
    }
  }
}

@Composable
internal fun rememberWorkspaceGeometry(
  options: WorkspaceDeviceControlOptions,
  layoutState: LayoutInspectorState,
  session: DeviceControlSession,
): DeviceFrameSnapshot? {
  return with(options) {
    // Re-evaluate on a slow ticker as well as on source updates: a stalled observation stream
    // produces
    // no updates, so its staleness is only visible as time passing.
    rememberControlFreshnessTick(enabled)
    session.evaluate(
      DeviceControlInputs(
        enabled = enabled,
        realDeviceMode = true,
        selectedDeviceId = column.deviceId,
        transportSupportsInput = true,
        observationStreamConnected = layoutState.connectionStatus == ConnectionStatus.Connected,
        screenshot = layoutState.screenshotFacts,
        hierarchy = layoutState.hierarchyFacts,
        // WebRTC/video has no capture identity; control maps and renders the paired screenshot.
        liveFrame = null,
      ),
    )

    // Geometry retention — the crux of the decoupling. Keep the last snapshot INDEFINITELY: device
    // width/height/rotation is a stable property, not a per-frame capture identity, so a click can
    // always be mapped through the most recent one and there is no freshness window to age out and
    // disarm the pane. The daemon dedupes hierarchy_updates, so on a static screen no new pair
    // arrives — under the old freshness gate the pane disarmed a few seconds after each tap ("one
    // click works, then it freezes"). A real rotation DOES produce a fresh snapshot that overwrites
    // this one, so the geometry self-heals; only the brief transient during a rotate is momentarily
    // stale, which is vastly preferable to a hard input freeze.
    val liveRender = session.renderSnapshot
    val sticky = remember(column.deviceId) { mutableStateOf<DeviceFrameSnapshot?>(null) }
    LaunchedEffect(liveRender) { if (liveRender != null) sticky.value = liveRender }
    val geometry = liveRender ?: sticky.value

    geometry
  }
}
