package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

private val LOG = LoggerFactory.getLogger("NavigationDashboard")

enum class NavigationSection {
  FlowMap,
  ScreenDetail,
  TransitionDetail,
}

/** Display context, data sources, and host callbacks for the navigation dashboard. */
data class NavigationDashboardOptions(
  val highlightedScreens: List<String> =
    emptyList(), // Screen names to highlight (e.g., from test flow)
  val currentStepScreen: String? = highlightedScreens.lastOrNull(), // Current step being replayed
  val onHighlightCleared: () -> Unit =
    {}, // Called when user interacts to clear external highlights
  val onDetailViewChanged: (Boolean) -> Unit =
    {}, // Called when entering/leaving a detail view (screen/transition)
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null, // MCP client for real data
  val selectedAppId: String? = null, // App ID to filter navigation graph by (managed by parent)
  val observationStreamClient: ObservationStream? =
    null, // Real-time stream client for navigation updates
  val screenshotLoader: ScreenshotLoader? =
    null, // Screenshot loader (hoisted to parent so cache persists across toggles)
  val settingsProvider: SettingsProvider =
    FakeSettingsProvider(), // Settings provider (caller injects real impl)
  // When true, never run the initial active-device data-source fetch; the graph is driven solely by
  // the per-device [observationStreamClient] (which the caller attaches). This keeps per-device
  // panes correct: the active-device fetch would otherwise briefly show the wrong device's graph
  // until the first stream push. The default preserves the existing (non-facet) fetch behavior.
  val streamOnly: Boolean = false,
  // When non-null the caller has already resolved the graph to render (e.g. an app-scoped pull in
  // [dev.jasonpearson.automobile.desktop.core.workspace.NavigationFacet]); the dashboard renders it
  // directly and runs neither the internal data-source fetch nor the stream collector. The default
  // (null) preserves the existing self-fetching behavior.
  val providedGraph: NavigationGraph? = null,
  // The active screen to pair with [providedGraph]. Because a provided graph bypasses the internal
  // stream collector (which normally sets `currentObservedScreen`), the caller must pass the
  // current screen here or the canvas's Fog toggle + auto-focus (both gated on a non-null current
  // screen) stay dead. Only consulted when [providedGraph] is non-null.
  val providedCurrentScreen: String? = null,
  // Read-only (offline) browse: when true the graph is inspectable — browsing, panning, zooming,
  // and
  // drilling into screen/transition detail all work — but device-side navigate actions (which need
  // a
  // live device) are unavailable and a "Navigate actions disabled (offline)" badge is shown. Used
  // by
  // the offline-browse surface (Phase C of #4837), which renders a persisted graph via
  // [providedGraph] with no observed device. Any future live "navigate device to this screen"
  // affordance must gate on this flag.
  val readOnly: Boolean = false,
  // Provenance-weighted opacity context (nav (app,build) Phase 2, #4985): a node/edge reached in
  // this active context renders at 100% opacity, one reached only historically / by another build
  // or device at 50%, with hover provenance on the faded ones. Null (the default, and the offline
  // case) renders the union at full opacity — there is no active build to contrast against.
  val activeContext: NavigationActiveContext? = null,
)

internal class NavigationDashboardState(options: NavigationDashboardOptions) {
  var currentSection by mutableStateOf(NavigationSection.FlowMap)
  var selectedScreenId by mutableStateOf<String?>(null)
  var selectedTransitionId by mutableStateOf<String?>(null)
  var fogModeEnabled by mutableStateOf(options.settingsProvider.fogModeEnabled)
  var currentObservedScreen by
    mutableStateOf(
      if (options.providedGraph != null) options.providedCurrentScreen else null,
    )
  var lastObservedAppId by mutableStateOf<String?>(null)
  var fitToViewTrigger by mutableStateOf(0)
  var navigationGraph by mutableStateOf(options.providedGraph)
  var isLoading by mutableStateOf(options.providedGraph == null)
  var error by mutableStateOf<String?>(null)

  fun failed(error: Exception) {
    LOG.error("Exception loading navigation data", error)
    this.error = error.message ?: "Unknown error"
    isLoading = false
  }

  fun selectScreen(id: String, onHighlightCleared: () -> Unit) {
    selectedScreenId = id
    currentSection = NavigationSection.ScreenDetail
    onHighlightCleared()
  }
}

@Composable
fun NavigationDashboard(
  options: NavigationDashboardOptions = NavigationDashboardOptions(),
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  mainDispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
  val state = remember { NavigationDashboardState(options) }
  LaunchedEffect(state.currentSection) {
    options.onDetailViewChanged(state.currentSection != NavigationSection.FlowMap)
  }
  ProvidedNavigationGraph(state, options)
  FetchNavigationGraph(state, options, ioDispatcher)
  StreamNavigationGraph(state, options, ioDispatcher, mainDispatcher)
  Box(modifier = Modifier.fillMaxSize()) {
    NavigationSectionContent(state, options)
    if (options.readOnly) ReadOnlyOfflineBadge(Modifier.align(Alignment.TopEnd).padding(12.dp))
  }
}

@Composable
private fun NavigationSectionContent(
  state: NavigationDashboardState,
  options: NavigationDashboardOptions,
) {
  val screens = state.navigationGraph?.screens ?: emptyList()
  val navigateToScreen: (String) -> Unit = { name ->
    screens.find { it.name == name }?.let { state.selectScreen(it.id, options.onHighlightCleared) }
  }
  when (state.currentSection) {
    NavigationSection.FlowMap -> NavigationFlowMap(state, options)
    NavigationSection.ScreenDetail -> NavigationScreenDetail(state, options, navigateToScreen)
    NavigationSection.TransitionDetail -> NavigationTransitionDetail(state, navigateToScreen)
  }
}

@Composable
private fun NavigationFlowMap(
  state: NavigationDashboardState,
  options: NavigationDashboardOptions,
) {
  Box(modifier = Modifier.fillMaxSize()) {
    NavigationCanvasView(
      dev.jasonpearson.automobile.desktop.core.navigation.NavigationCanvasOptions(
        screens = state.navigationGraph?.screens ?: emptyList(),
        transitions = state.navigationGraph?.transitions ?: emptyList(),
        onScreenSelected = { state.selectScreen(it, options.onHighlightCleared) },
        externalHighlightedScreens = options.highlightedScreens,
        currentReplayScreen = options.currentStepScreen,
        screenshotLoader = options.screenshotLoader,
        fogModeEnabled = state.fogModeEnabled,
        currentObservedScreen = state.currentObservedScreen,
        onFogModeToggled = { enabled ->
          state.fogModeEnabled = enabled
          options.settingsProvider.fogModeEnabled = enabled
        },
        fitToViewTrigger = state.fitToViewTrigger,
        activeContext = options.activeContext,
      ),
    )
  }
}

@Composable
private fun NavigationScreenDetail(
  state: NavigationDashboardState,
  options: NavigationDashboardOptions,
  navigateToScreen: (String) -> Unit,
) {
  val screens = state.navigationGraph?.screens ?: emptyList()
  val screen =
    screens.find { it.id == state.selectedScreenId }
      ?: screens.find { it.name == state.selectedScreenId }
      ?: screens.firstOrNull()
  if (screen != null) {
    ScreenDetailView(
      screen = screen,
      transitions = state.navigationGraph?.transitions ?: emptyList(),
      onBack = { state.currentSection = NavigationSection.FlowMap },
      onScreenSelected = navigateToScreen,
      screenshotLoader = options.screenshotLoader,
    )
  } else state.currentSection = NavigationSection.FlowMap
}

@Composable
private fun NavigationTransitionDetail(
  state: NavigationDashboardState,
  navigateToScreen: (String) -> Unit,
) {
  val transitions = state.navigationGraph?.transitions ?: emptyList()
  val transition =
    transitions.find { it.id == state.selectedTransitionId } ?: transitions.firstOrNull()
  if (transition != null) {
    TransitionDetailView(
      transition = transition,
      onBack = { state.currentSection = NavigationSection.FlowMap },
      onScreenSelected = navigateToScreen,
    )
  } else state.currentSection = NavigationSection.FlowMap
}

/**
 * Corner badge shown while browsing a persisted graph with no live device. Communicates that
 * navigate actions (which need a device) are unavailable; browsing/panning still work. Its stable
 * content description is the offline read-only signal the UI tests assert on.
 */
@Composable
private fun ReadOnlyOfflineBadge(modifier: Modifier = Modifier) {
  Box(
    modifier =
      modifier
        .background(
          MaterialTheme.colorScheme.surfaceVariant,
          RoundedCornerShape(6.dp),
        )
        .padding(horizontal = 8.dp, vertical = 4.dp)
        .semantics { contentDescription = "Navigate actions disabled (offline)" },
  ) {
    Text(
      "Read-only · offline",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      fontSize = 11.sp,
    )
  }
}
