package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.tabs.PanelHeader
import dev.jasonpearson.automobile.desktop.core.tabs.VerticalCollapsibleTab
import dev.jasonpearson.automobile.desktop.core.tabs.VerticalTabOptions
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first

/**
 * Main Layout Inspector dashboard with 3-panel layout:
 * - Left: Device screen with screenshot and overlays (expands when panels collapse)
 * - Center: View hierarchy tree (collapsible)
 * - Right: Property inspector (collapsible)
 */
data class LayoutInspectorOptions(
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val deviceId: String? = null,
  val platform: String = "android",
  val onRestartDaemon: (() -> Unit)? = null,
  val liveFrame: androidx.compose.ui.graphics.ImageBitmap? = null,
  val connectionGeneration: Int = 0,
  val frameDispatcher: CoroutineDispatcher = Dispatchers.Default,
  val beforeHierarchyParse: suspend () -> Unit = {},
  val onHierarchyUnavailable: (String) -> Unit = {},
  val socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
)

@Composable
fun LayoutInspectorDashboard(
  options: LayoutInspectorOptions = LayoutInspectorOptions(),
  modifier: Modifier = Modifier,
  observationStream: ObservationStream,
) {
  val state = rememberLayoutInspectorState()
  val streamClient = observationStream
  val generation = remember(streamClient) { mutableStateOf(options.connectionGeneration) }
  val dashboardLog =
    dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger(
      "LayoutInspectorDashboard",
    )
  CollectLayoutHierarchy(options, state, streamClient, generation, dashboardLog)
  CollectLayoutScreenshots(options, state, streamClient, generation, dashboardLog)
  ObserveLayoutConnection(options, state, streamClient, dashboardLog)
  val socketExists = rememberLayoutSocketAvailable(options, state)
  LaunchedEffect(observationStream, options.deviceId, options.connectionGeneration) {
    observationStream.requestObservation(options.deviceId)
  }
  LayoutInspectorPanels(options, state, socketExists, modifier)
}

private class LayoutPanelState(initialHierarchyWidth: Float, initialPropertiesWidth: Float) {
  var isHierarchyCollapsed by mutableStateOf(true)
  var isPropertiesCollapsed by mutableStateOf(true)
  var flashElementId by mutableStateOf<String?>(null)
  var hierarchyWidthPx by mutableFloatStateOf(initialHierarchyWidth)
  var propertiesWidthPx by mutableFloatStateOf(initialPropertiesWidth)
}

private data class LayoutPanelBounds(val min: Float, val max: Float)

@Composable
private fun CollectLayoutHierarchy(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
  streamClient: ObservationStream,
  generationState: androidx.compose.runtime.MutableState<Int>,
  dashboardLog: dev.jasonpearson.automobile.desktop.core.logging.Logger,
) {
  val connectionGeneration = options.connectionGeneration
  var collectorGeneration by generationState
  // Collect hierarchy updates from the stream
  LaunchedEffect(streamClient, connectionGeneration) {
    if (collectorGeneration != connectionGeneration) {
      // Cancelling the old collector discards its buffered pre-outage frames. Clear replay before
      // subscribing again, so the new collector cannot mistake that replay for a fresh frame.
      state.disconnect()
      streamClient.resetLayoutReplayCache()
    }
    collectorGeneration = connectionGeneration
    dashboardLog.info(
      "Starting hierarchy updates collection from stream client: ${streamClient.hashCode()}",
    )
    streamClient.hierarchyUpdates.collect { update ->
      dashboardLog.info(
        "Received hierarchy update in dashboard - deviceId=${update.deviceId}, hasData=${update.data != null}",
      )
      update.data?.let { hierarchyJson ->
        applyLayoutHierarchy(options, state, update, hierarchyJson, dashboardLog)
      }
    }
  }
}

private suspend fun applyLayoutHierarchy(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
  update: dev.jasonpearson.automobile.desktop.core.daemon.HierarchyStreamUpdate,
  hierarchyJson: kotlinx.serialization.json.JsonElement,
  dashboardLog: dev.jasonpearson.automobile.desktop.core.logging.Logger,
) {
  val frameDispatcher = options.frameDispatcher
  val beforeHierarchyParse = options.beforeHierarchyParse
  val onHierarchyUnavailable = options.onHierarchyUnavailable
  val deviceId = options.deviceId
  val frameGeneration = state.frameGeneration
  dashboardLog.info("Parsing hierarchy JSON...")
  val result =
    kotlinx.coroutines.withContext(frameDispatcher) {
      beforeHierarchyParse()
      val parsed = parseHierarchyFromJson(hierarchyJson) ?: return@withContext null
      val oldMap = state.currentElementMap
      val changedIds = state.computeChangedElements(oldMap, parsed.elementMap)
      parsed to changedIds
    }
  if (result != null) {
    if (frameGeneration != state.frameGeneration) return
    dashboardLog.info(
      "Parsed hierarchy: root=${result.first.root.className}, children=${result.first.root.children.size}",
    )
    state.updateConnectionStatus(ConnectionStatus.Connected)
    state.applyHierarchyUpdate(
      parsed = result.first,
      changedIds = result.second,
      generation = frameGeneration,
      options =
        HierarchyUpdateOptions(
          deviceId = update.deviceId ?: deviceId,
        ),
    )
    dashboardLog.info("Updated state with new hierarchy")
  } else {
    if (frameGeneration == state.frameGeneration) {
      if (state.recordHierarchyUnavailable(hierarchyJson)) {
        onHierarchyUnavailable(state.hierarchyUnavailableReason.orEmpty())
      } else {
        dashboardLog.warn("Failed to parse hierarchy from JSON")
      }
    }
  }
}

@Composable
private fun CollectLayoutScreenshots(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
  streamClient: ObservationStream,
  generationState: androidx.compose.runtime.MutableState<Int>,
  dashboardLog: dev.jasonpearson.automobile.desktop.core.logging.Logger,
) {
  val connectionGeneration = options.connectionGeneration
  var collectorGeneration by generationState
  val frameDispatcher = options.frameDispatcher
  val deviceId = options.deviceId
  // Collect screenshot updates from the stream
  LaunchedEffect(streamClient, connectionGeneration) {
    if (collectorGeneration != connectionGeneration) {
      snapshotFlow { collectorGeneration }.first { it == connectionGeneration }
    }
    dashboardLog.info(
      "Starting screenshot updates collection from stream client: ${streamClient.hashCode()}",
    )
    streamClient.screenshotUpdates.collect { update ->
      dashboardLog.info(
        "Received screenshot update in dashboard - deviceId=${update.deviceId}, hasScreenshot=${update.screenshotBase64 != null}",
      )
      update.screenshotBase64?.let { base64 ->
        val frameGeneration = state.frameGeneration
        // Decode base64 to byte array off main thread
        val screenshotData =
          kotlinx.coroutines.withContext(frameDispatcher) {
            java.util.Base64.getDecoder().decode(base64)
          }
        if (frameGeneration != state.frameGeneration) return@let
        dashboardLog.info("Decoded screenshot: ${screenshotData.size} bytes")
        state.updateConnectionStatus(ConnectionStatus.Connected)
        state.updateScreenshot(
          data = screenshotData,
          width = update.screenWidth,
          height = update.screenHeight,
          timestamp = update.timestamp,
          options =
            ScreenshotUpdateOptions(
              fallback = update.screenshotFallback ?: false,
              fallbackReason = update.screenshotFallbackReason,
              format = update.screenshotFormat,
              captureSource = update.screenshotCaptureSource,
              deviceId = update.deviceId ?: deviceId,
              generation = frameGeneration,
            ),
        )
        dashboardLog.info("Updated state with new screenshot")
      }
    }
  }
}

@Composable
private fun ObserveLayoutConnection(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
  streamClient: ObservationStream,
  dashboardLog: dev.jasonpearson.automobile.desktop.core.logging.Logger,
) {
  val dataSourceMode = options.dataSourceMode

  val connectionGeneration = options.connectionGeneration
  // Collect stream connection state to update layout inspector state (Real mode only)
  // Uses a grace period to absorb brief disconnections during reconnection,
  // preventing the UI from flashing "Device Disconnected" on transient interruptions.
  if (dataSourceMode == DataSourceMode.Real) {
    val gracePeriodScope = rememberCoroutineScope()
    val gracePeriod =
      remember(state, streamClient) {
        StreamConnectionGracePeriod(
          scope = gracePeriodScope,
          onStatusChange = { status -> state.updateConnectionStatus(status) },
          onDisconnectConfirmed = { state.disconnect() },
        )
      }
    DisposableEffect(gracePeriod) {
      onDispose { gracePeriod.cancel() }
    }
    LaunchedEffect(streamClient, gracePeriod) {
      streamClient.connectionState.collect { connectionState ->
        gracePeriod.onStreamStateChange(connectionState)
      }
    }
    var observedGeneration by remember(streamClient) { mutableStateOf(0) }
    LaunchedEffect(streamClient, connectionGeneration) {
      if (observedGeneration != 0 && observedGeneration != connectionGeneration) {
        // A fast drop/reconnect can leave connectionState value-equal to the old Connected state.
        // Clear the old hierarchy and screenshot even when the grace-period collector missed it.
        gracePeriod.onStreamStateChange(streamClient.connectionState.value)
      }
      observedGeneration = connectionGeneration
    }
    LaunchedEffect(streamClient) {
      streamClient.deviceEvents.collect { event ->
        when (event) {
          is DeviceStreamEvent.DeviceSessionSuperseded -> Unit
          is DeviceStreamEvent.DeviceConnectionLost -> {
            dashboardLog.warn("Device connection lost for ${event.deviceId}: ${event.error}")
            state.disconnect()
          }
        }
      }
    }
  }
}

@Composable
private fun rememberLayoutSocketAvailable(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
): Boolean {
  val socketAvailable = options.socketAvailable
  // Poll socket existence so the UI reacts when the daemon starts or stops.
  // Only active when disconnected/connecting — connected state doesn't need this.
  var socketExists by remember { mutableStateOf(socketAvailable()) }
  val isDisconnectedOrConnecting =
    state.connectionStatus == ConnectionStatus.Disconnected ||
      state.connectionStatus == ConnectionStatus.Connecting
  LaunchedEffect(isDisconnectedOrConnecting) {
    if (isDisconnectedOrConnecting) {
      while (true) {
        socketExists = socketAvailable()
        kotlinx.coroutines.delay(2000)
      }
    } else {
      socketExists = true
    }
  }

  return socketExists
}

@Composable
private fun LayoutInspectorPanels(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
  socketExists: Boolean,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  with(options) {
    val density = LocalDensity.current
    val panels = remember {
      LayoutPanelState(with(density) { 420.dp.toPx() }, with(density) { 330.dp.toPx() })
    }
    with(panels) {
      // Panel collapse states - default to collapsed, remember user preference
      // TODO: Persist these to IDE preferences for remembering across sessions

      // Reset Properties panel to collapsed when selection is cleared
      // This ensures it starts collapsed next time user selects an element
      LaunchedEffect(state.selectedElementId) {
        if (state.selectedElementId == null) {
          isPropertiesCollapsed = true
        }
      }

      // Flash state for highlighting element in device view on double-click

      // Resizable panel widths (in pixels for precise drag handling)
      val minPanelWidthPx = with(density) { 225.dp.toPx() } // 150 * 1.5
      val maxPanelWidthPx = with(density) { 500.dp.toPx() }

      // Refit trigger - changes when panel collapse states change or selection changes to recenter
      // the
      // device view
      val hasSelection = state.selectedElementId != null
      val refitTrigger =
        remember(isHierarchyCollapsed, isPropertiesCollapsed, hasSelection) {
          "$isHierarchyCollapsed-$isPropertiesCollapsed-$hasSelection-${System.currentTimeMillis()}"
        }

      // Main content with 3 panels
      Row(modifier = modifier.fillMaxSize()) {
        LayoutDevicePanel(options, state, panels, refitTrigger, socketExists)
        LayoutHierarchyPanel(state, panels, LayoutPanelBounds(minPanelWidthPx, maxPanelWidthPx))
        LayoutPropertiesPanel(state, panels, LayoutPanelBounds(minPanelWidthPx, maxPanelWidthPx))
      }
    }
  }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.LayoutDevicePanel(
  options: LayoutInspectorOptions,
  state: LayoutInspectorState,
  panels: LayoutPanelState,
  refitTrigger: String,
  socketExists: Boolean,
) {
  val colors = SharedTheme.globalColors
  with(options) {
    with(panels) {
      // Left panel: Device Screen (flexible - expands when others collapse)
      Box(
        modifier =
          Modifier.weight(1f).fillMaxHeight().background(colors.text.normal.copy(alpha = 0.02f)),
      ) {
        DeviceScreenView(
          screenshotData = state.screenshotData,
          liveFrame = liveFrame,
          modifier = Modifier.fillMaxSize(),
          options =
            DeviceScreenOptions(
              screenWidth = state.screenWidth,
              screenHeight = state.screenHeight,
              rotation = state.rotation,
              hierarchy = state.hierarchy,
              selectedElementId = state.selectedElementId,
              hoveredElementId = state.hoveredElementId,
              flashElementId = flashElementId,
              onFlashComplete = { flashElementId = null },
              onElementSelected = { state.selectElement(it) },
              onElementHovered = { state.hoverElement(it) },
              showTapTargetIssues = state.showTapTargetIssues,
              onToggleTapTargetIssues = { state.toggleTapTargetIssues() },
              connectionStatus = state.connectionStatus,
              hierarchyUnavailableReason = state.hierarchyUnavailableReason,
              socketExists = socketExists,
              onRestartDaemon = onRestartDaemon,
              elementMap = state.currentElementMap.takeIf { it.isNotEmpty() },
              refitTrigger = refitTrigger,
            ),
        )

        // The metadata badge describes the SCREENSHOT pixels (format/fallback/capture source), so
        // it
        // only applies while the screenshot is what's on screen — live video renders instead of it.
        if (liveFrame == null) {
          ScreenshotMetadataOverlay(
            fallback = state.screenshotFallback,
            fallbackReason = state.screenshotFallbackReason,
            format = state.screenshotFormat,
            captureSource = state.screenshotCaptureSource,
            modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
          )
        }
      }
    }
  }
}

@Composable
private fun LayoutHierarchyPanel(
  state: LayoutInspectorState,
  panels: LayoutPanelState,
  bounds: LayoutPanelBounds,
) {
  val minPanelWidthPx = bounds.min
  val maxPanelWidthPx = bounds.max
  with(panels) {
    // Center panel: View Hierarchy (collapsible + resizable)
    VerticalCollapsibleTab(
      options =
        VerticalTabOptions(
          title = "View Hierarchy",
          isCollapsed = isHierarchyCollapsed,
          onToggle = { isHierarchyCollapsed = !isHierarchyCollapsed },
          widthPx = hierarchyWidthPx,
          onWidthChange = { delta ->
            hierarchyWidthPx = (hierarchyWidthPx - delta).coerceIn(minPanelWidthPx, maxPanelWidthPx)
          },
          resizeHandleOnLeft = true,
        ),
    ) {
      Column(modifier = Modifier.fillMaxSize()) {
        PanelHeader(
          title = "View Hierarchy",
          onCollapse = { isHierarchyCollapsed = true },
        )
        HierarchyTreeView(
          options =
            HierarchyTreeOptions(
              hierarchy = state.hierarchy,
              selectedElementId = state.selectedElementId,
              hoveredElementId = state.hoveredElementId,
              onElementSelected = { state.selectElement(it) },
              onElementHovered = { state.hoverElement(it) },
              onElementDoubleClicked = { elementId ->
                // Select the element
                state.selectElement(elementId)
                // Flash highlight in the device view
                flashElementId = elementId
                // Open the properties panel
                isPropertiesCollapsed = false
              },
              parentMap = state.parentMap,
            ),
          modifier = Modifier.fillMaxSize(),
        )
      }
    }
  }
}

@Composable
private fun LayoutPropertiesPanel(
  state: LayoutInspectorState,
  panels: LayoutPanelState,
  bounds: LayoutPanelBounds,
) {
  val minPanelWidthPx = bounds.min
  val maxPanelWidthPx = bounds.max
  with(panels) {
    // Right panel: Properties (only shown when an element is selected)
    if (state.selectedElementId != null) {
      VerticalCollapsibleTab(
        options =
          VerticalTabOptions(
            title = "Properties",
            isCollapsed = isPropertiesCollapsed,
            onToggle = { isPropertiesCollapsed = !isPropertiesCollapsed },
            widthPx = propertiesWidthPx,
            onWidthChange = { delta ->
              propertiesWidthPx =
                (propertiesWidthPx - delta).coerceIn(minPanelWidthPx, maxPanelWidthPx)
            },
            resizeHandleOnLeft = true,
          ),
      ) {
        Column(modifier = Modifier.fillMaxSize()) {
          PanelHeader(
            title = "Properties",
            onCollapse = { isPropertiesCollapsed = true },
          )
          PropertyInspectorPanel(
            element = state.selectedElement,
            modifier = Modifier.fillMaxSize(),
          )
        }
      }
    }
  }
}
