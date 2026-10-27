package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/** Toggle streaming mode (live/paused). */
fun LayoutInspectorState.toggleStreaming() {
  streamingMode =
    when (streamingMode) {
      StreamingMode.Live -> StreamingMode.Paused
      StreamingMode.Paused -> StreamingMode.Live
    }
}

/** Update streaming mode. */
fun LayoutInspectorState.updateStreamingMode(mode: StreamingMode) {
  streamingMode = mode
}

/** Connect to device. Phase 1: Simulates connection Phase 2: Will establish WebSocket connection */
fun LayoutInspectorState.connect() {
  connectionStatus = ConnectionStatus.Connecting
  // Simulate connection delay then connect
  connectionStatus = ConnectionStatus.Connected
  loadMockData()
}

/** Update connection status externally (e.g., from stream connection state). */
fun LayoutInspectorState.updateConnectionStatus(status: ConnectionStatus) {
  connectionStatus = status
}

/** Disconnect from device. Clears all device-specific stale data. */
fun LayoutInspectorState.disconnect() {
  debounceJob?.cancel()
  // Advance the generation so any in-flight decode/debounced job from before the disconnect is
  // dropped instead of repopulating stale state.
  advanceGeneration()
  connectionStatus = ConnectionStatus.Disconnected
  hierarchyUnavailableReason = null
  streamingMode = StreamingMode.Paused
  screenshotData = null
  screenshotFallback = false
  screenshotFallbackReason = null
  screenshotFormat = null
  screenshotCaptureSource = null
  renderedDeviceId = null
  renderedScreenshotRotation = null
  renderedHierarchyDeviceId = null
  screenshotFacts = null
  hierarchyFacts = null
  currentParsedHierarchy = null
  rotation = 0
  selectedElementId = null
  selectedElement = null
  hoveredElementId = null
  changedElementIds = emptySet()
}

/** Start screenshot streaming. Phase 2: Will send subscribe_screenshots message via WebSocket. */
fun LayoutInspectorState.startScreenshotStream(intervalMs: Int = 100, quality: Int = 70) {
  streamingMode = StreamingMode.Live
  // Phase 2: Send WebSocket message
  // { "type": "subscribe_screenshots", "intervalMs": intervalMs, "quality": quality }
}

/** Stop screenshot streaming. Phase 2: Will send unsubscribe_screenshots message via WebSocket. */
fun LayoutInspectorState.stopScreenshotStream() {
  streamingMode = StreamingMode.Paused
  // Phase 2: Send WebSocket message
  // { "type": "unsubscribe_screenshots" }
}
