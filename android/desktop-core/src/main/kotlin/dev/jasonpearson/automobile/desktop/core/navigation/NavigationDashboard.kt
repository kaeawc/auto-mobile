package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider

private val LOG = LoggerFactory.getLogger("NavigationDashboard")

enum class NavigationSection {
  FlowMap,
  ScreenDetail,
  TransitionDetail,
}

@Composable
fun NavigationDashboard(
  highlightedScreens: List<String> =
    emptyList(), // Screen names to highlight (e.g., from test flow)
  currentStepScreen: String? = highlightedScreens.lastOrNull(), // Current step being replayed
  onHighlightCleared: () -> Unit = {}, // Called when user interacts to clear external highlights
  onDetailViewChanged: (Boolean) -> Unit =
    {}, // Called when entering/leaving a detail view (screen/transition)
  dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  clientProvider: (() -> AutoMobileClient)? = null, // MCP client for real data
  selectedAppId: String? = null, // App ID to filter navigation graph by (managed by parent)
  observationStreamClient: ObservationStream? =
    null, // Real-time stream client for navigation updates
  screenshotLoader: ScreenshotLoader? =
    null, // Screenshot loader (hoisted to parent so cache persists across toggles)
  settingsProvider: SettingsProvider =
    FakeSettingsProvider(), // Settings provider (caller injects real impl)
  // When true, never run the initial active-device data-source fetch; the graph is driven solely by
  // the per-device [observationStreamClient] (which the caller attaches). This keeps per-device
  // panes correct: the active-device fetch would otherwise briefly show the wrong device's graph
  // until the first stream push. The default preserves the existing (non-facet) fetch behavior.
  streamOnly: Boolean = false,
  // When non-null the caller has already resolved the graph to render (e.g. an app-scoped pull in
  // [dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet]); the dashboard renders it
  // directly and runs neither the internal data-source fetch nor the stream collector. The default
  // (null) preserves the existing self-fetching behavior.
  providedGraph: NavigationGraph? = null,
) {
  val graph = LocalAutoMobileGraph.current
  var currentSection by remember { mutableStateOf(NavigationSection.FlowMap) }
  var selectedScreenId by remember { mutableStateOf<String?>(null) }
  var selectedTransitionId by remember { mutableStateOf<String?>(null) }

  // Notify parent when entering/leaving detail view
  LaunchedEffect(currentSection) {
    onDetailViewChanged(currentSection != NavigationSection.FlowMap)
  }

  // Fog mode settings - read from persisted settings (fog+auto are one combined toggle)
  var fogModeEnabled by remember { mutableStateOf(settingsProvider.fogModeEnabled) }

  // Track current screen and app from navigation stream
  var currentObservedScreen by remember { mutableStateOf<String?>(null) }
  var lastObservedAppId by remember { mutableStateOf<String?>(null) }
  // Incremented when we want the canvas to re-fit to show the entire graph
  var fitToViewTrigger by remember { mutableStateOf(0) }

  // Fetch navigation data from data source
  var navigationGraph by remember { mutableStateOf(providedGraph) }
  var isLoading by remember { mutableStateOf(providedGraph == null) }
  var error by remember { mutableStateOf<String?>(null) }

  // Caller-provided graph wins: render it directly and keep it in sync across recompositions,
  // bypassing the internal fetch and stream collector below.
  LaunchedEffect(providedGraph) {
    if (providedGraph != null) {
      navigationGraph = providedGraph
      isLoading = false
      error = null
    }
  }

  LaunchedEffect(dataSourceMode, clientProvider, selectedAppId, streamOnly, providedGraph) {
    // A caller-provided graph is authoritative; never run the internal fetch.
    if (providedGraph != null) return@LaunchedEffect
    // Stream-only: never run the active-device data-source fetch — the graph is driven solely by
    // this pane's per-device stream. Gated on streamOnly directly (not stream presence): the facet
    // attaches its stream via DisposableEffect AFTER first composition, so keying on the attached
    // stream would still let the fetch fire once on mount and briefly show the wrong device's
    // graph.
    if (streamOnly) {
      isLoading = false
      return@LaunchedEffect
    }
    LOG.info(
      "Loading navigation data with mode: $dataSourceMode, appId: $selectedAppId, clientProvider=${if (clientProvider != null) "present" else "null"}"
    )
    isLoading = true
    error = null
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
      try {
        val dataSource =
          graph.dataSourceFactory.createNavigationDataSource(
            dataSourceMode,
            clientProvider,
            selectedAppId,
          )
        when (val result = dataSource.getNavigationGraph()) {
          is Result.Success -> {
            LOG.info(
              "Navigation data loaded: ${result.data.screens.size} screens, ${result.data.transitions.size} transitions"
            )
            navigationGraph = result.data
            isLoading = false
          }
          is Result.Error -> {
            LOG.warn("Failed to load navigation data: ${result.message}")
            error = result.message
            isLoading = false
          }
          is Result.Loading -> {
            // Keep loading state
          }
        }
      } catch (e: Exception) {
        LOG.error("Exception loading navigation data", e)
        error = e.message ?: "Unknown error"
        isLoading = false
      }
    }
  }

  // Request latest navigation graph on composition entry and when stream client becomes available
  LaunchedEffect(observationStreamClient, providedGraph) {
    if (providedGraph != null) return@LaunchedEffect
    if (observationStreamClient != null) {
      kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        observationStreamClient.requestNavigationGraph()
      }
    }
  }

  // Collect real-time navigation updates from the stream
  LaunchedEffect(observationStreamClient, selectedAppId, providedGraph) {
    if (providedGraph != null) return@LaunchedEffect
    if (observationStreamClient == null) return@LaunchedEffect

    LOG.info("Starting navigation updates collection from stream client")
    observationStreamClient.navigationUpdates.collect { update ->
      // Only update if it's for the selected app (or if no app filter is set)
      if (selectedAppId == null || update.appId == selectedAppId) {
        LOG.info(
          "Received navigation update - appId=${update.appId}, nodes=${update.nodes.size}, edges=${update.edges.size}, currentScreen=${update.currentScreen}"
        )
        // Check for foreground app change before switching to Main
        val newAppId = update.appId
        val appChanged =
          lastObservedAppId != null && newAppId != null && newAppId != lastObservedAppId
        if (appChanged) {
          LOG.info("Foreground app changed: $lastObservedAppId -> $newAppId, requesting nav graph")
          // Request the full navigation graph for the new foreground app (non-suspending IO call)
          observationStreamClient.requestNavigationGraph(newAppId)
        }
        // Ensure state updates happen on the main thread for proper recomposition
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
          if (appChanged) {
            fogModeEnabled = false
            settingsProvider.fogModeEnabled = false
            fitToViewTrigger++
          }
          lastObservedAppId = newAppId
          navigationGraph = convertStreamUpdateToGraph(update)
          currentObservedScreen = update.currentScreen
          isLoading = false
          error = null
        }
      }
    }
  }

  // Use fetched data or fall back to empty lists
  val screens = navigationGraph?.screens ?: emptyList()
  val transitions = navigationGraph?.transitions ?: emptyList()

  // Helper to navigate to a screen by name
  val navigateToScreen: (String) -> Unit = { screenName ->
    // Find screen by name and set its ID
    val screen = screens.find { it.name == screenName }
    if (screen != null) {
      selectedScreenId = screen.id
      currentSection = NavigationSection.ScreenDetail
      onHighlightCleared() // Clear external highlights when navigating
    }
  }

  when (currentSection) {
    NavigationSection.FlowMap ->
      Box(modifier = Modifier.fillMaxSize()) {
        NavigationCanvasView(
          screens = screens,
          transitions = transitions,
          onScreenSelected = { screenId ->
            selectedScreenId = screenId
            currentSection = NavigationSection.ScreenDetail
            onHighlightCleared()
          },
          externalHighlightedScreens = highlightedScreens,
          currentReplayScreen = currentStepScreen,
          screenshotLoader = screenshotLoader,
          fogModeEnabled = fogModeEnabled,
          currentObservedScreen = currentObservedScreen,
          onFogModeToggled = { enabled ->
            fogModeEnabled = enabled
            settingsProvider.fogModeEnabled = enabled
          },
          fitToViewTrigger = fitToViewTrigger,
        )
      }

    NavigationSection.ScreenDetail -> {
      val screen =
        screens.find { it.id == selectedScreenId }
          ?: screens.find { it.name == selectedScreenId }
          ?: screens.firstOrNull()

      if (screen != null) {
        ScreenDetailView(
          screen = screen,
          transitions = transitions,
          onBack = { currentSection = NavigationSection.FlowMap },
          onScreenSelected = navigateToScreen,
          screenshotLoader = screenshotLoader,
        )
      } else {
        currentSection = NavigationSection.FlowMap
      }
    }

    NavigationSection.TransitionDetail -> {
      val transition =
        transitions.find { it.id == selectedTransitionId } ?: transitions.firstOrNull()

      if (transition != null) {
        TransitionDetailView(
          transition = transition,
          onBack = { currentSection = NavigationSection.FlowMap },
          onScreenSelected = navigateToScreen,
        )
      } else {
        currentSection = NavigationSection.FlowMap
      }
    }
  }
}

/** Convert a navigation graph stream update to the NavigationGraph format used by the UI. */
private fun convertStreamUpdateToGraph(update: NavigationGraphStreamUpdate): NavigationGraph {
  val screens =
    update.nodes.map { node ->
      ScreenNode(
        id = node.id.toString(),
        name = node.screenName,
        type = "Screen", // Default type
        packageName = update.appId ?: "",
        transitionCount = node.visitCount,
        discoveredAt = 0L, // Not available from stream
        screenshotUri = node.screenshotPath,
      )
    }

  val transitions =
    update.edges.map { edge ->
      ScreenTransition(
        id = edge.id.toString(),
        fromScreen = edge.from,
        toScreen = edge.to,
        trigger = edge.toolName ?: "unknown",
        element = null, // Not available from stream
        avgLatencyMs = 0, // Not available from stream
        failureRate = 0f, // Not available from stream
        traversalCount = edge.traversalCount,
      )
    }

  return NavigationGraph(screens = screens, transitions = transitions)
}
