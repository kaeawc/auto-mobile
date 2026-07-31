package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.RealNavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboard
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private sealed interface NavigationFacetState {
  /** No foreground app resolved yet, or the app-scoped pull is in flight. */
  data object Loading : NavigationFacetState

  /** The resolved app has no recorded navigation graph. */
  data object Empty : NavigationFacetState

  data class Error(val message: String) : NavigationFacetState

  data class Resolved(val graph: NavigationGraph) : NavigationFacetState
}

/**
 * Docked-facet body for [Tool.Navigation]. Navigation is **app-scoped**, not device-scoped (Phase C
 * of the nav-graph model, #4837): the daemon persists one graph per app, so this facet renders the
 * app-level graph for whichever app is in the foreground on the pane's device.
 *
 * Mechanism — **app-scoped pull** (the contamination-safe option from #4909). A per-device
 * [ObservationStream] is connected while the facet is shown (mirroring [LogsFacet]'s
 * connect/dispose lifecycle, keyed on [DeviceColumn.deviceId]) purely to (a) satisfy that
 * per-device lifecycle and (b) resolve which app is in the foreground on this pane's device (from
 * the stream's `appId`). The graph itself is then **pulled** by app id via a [NavigationDataSource]
 * (default [RealNavigationDataSource], which reads the daemon's app-keyed
 * `automobile:navigation/graph?appId=…` resource). This is a stable snapshot: two panes observing
 * the *same* app pull the same app-keyed graph and therefore render identical data (correct under
 * the app-level model), and a foreign app's broadcast can never overwrite a pane's rendered graph
 * the way the raw stream did (#4838).
 *
 * Known caveat (deferred to the `(app, build)` phase, #4837): `NavigationGraphStreamUpdate` carries
 * an `appId` but no `deviceId`, so when two panes run *different* apps a foreground-app update
 * broadcast for one device can be misattributed to the other pane. Full disambiguation needs the
 * deviceId/build discriminator that lands in a later phase; we do not block on it here.
 *
 * [observationStreamFactory] and [navigationDataSourceProvider] are injected so the whole
 * lifecycle + loading/empty/error/resolved behavior is testable with a
 * [dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream] and a fake data source,
 * with no socket or live MCP daemon.
 */
@Composable
fun NavigationFacet(
  column: DeviceColumn,
  observationStreamFactory: (String) -> ObservationStream = { ObservationStreamClient() },
  navigationDataSourceProvider: ((String) -> NavigationDataSource)? = null,
) {
  val graph = LocalAutoMobileGraph.current

  var stream by remember(column.deviceId) { mutableStateOf<ObservationStream?>(null) }
  DisposableEffect(column.deviceId) {
    val connected =
      observationStreamFactory(column.deviceId).also { it.connect(deviceId = column.deviceId) }
    // Prompt the daemon to emit the current foreground app so we can resolve which app's graph to
    // pull; the emitted update carries the appId.
    connected.requestNavigationGraph()
    stream = connected
    onDispose {
      connected.dispose()
      stream = null
    }
  }

  // Foreground app for THIS pane's device, resolved from the nav stream. Reset when the pane's
  // device changes so a new device re-resolves its own foreground app.
  var foregroundAppId by remember(column.deviceId) { mutableStateOf<String?>(null) }
  LaunchedEffect(stream) {
    val current = stream ?: return@LaunchedEffect
    current.navigationUpdates.collect { update ->
      val appId = update.appId
      if (appId != null) foregroundAppId = appId
    }
  }

  val sourceProvider =
    navigationDataSourceProvider
      ?: { appId ->
        RealNavigationDataSource(clientProvider = { graph.autoMobileClient }, appId = appId)
      }

  var attempt by remember(column.deviceId) { mutableStateOf(0) }
  var state by
    remember(column.deviceId) { mutableStateOf<NavigationFacetState>(NavigationFacetState.Loading) }

  LaunchedEffect(column.deviceId, foregroundAppId, attempt) {
    val appId = foregroundAppId
    if (appId == null) {
      // No foreground app resolved yet: never pull with a null app id (that would surface the
      // wrong/global graph). Stay in Loading until the stream reports the foreground app.
      state = NavigationFacetState.Loading
      return@LaunchedEffect
    }
    state = NavigationFacetState.Loading
    // Read off the UI thread: the resource read hits the daemon and would otherwise block
    // recomposition. Injected test data sources run inline (deterministic).
    state =
      when (
        val result = withContext(Dispatchers.IO) { sourceProvider(appId).getNavigationGraph() }
      ) {
        is Result.Success ->
          if (result.data.screens.isEmpty()) NavigationFacetState.Empty
          else NavigationFacetState.Resolved(result.data)
        is Result.Error ->
          NavigationFacetState.Error(result.message ?: "Failed to load navigation graph")
        // A one-shot read resolves to Success/Error; treat a stray Loading as retryable.
        Result.Loading -> NavigationFacetState.Error("Navigation graph is still loading")
      }
  }

  val clientProvider = remember { { graph.autoMobileClient } }
  // Remembered per device so its LRU cache survives facet toggles.
  val screenshotLoader =
    remember(column.deviceId) { NavigationScreenshotLoader(clientProvider = clientProvider) }

  when (val current = state) {
    NavigationFacetState.Loading -> NavigationFacetNote("Resolving navigation graph…")
    NavigationFacetState.Empty ->
      NavigationFacetNote("No navigation graph recorded for this app yet")
    is NavigationFacetState.Error -> NavigationFacetError(current.message) { attempt++ }
    is NavigationFacetState.Resolved ->
      NavigationDashboard(
        providedGraph = current.graph,
        clientProvider = clientProvider,
        settingsProvider = graph.settingsProvider,
        selectedAppId = foregroundAppId,
        screenshotLoader = screenshotLoader,
        streamOnly = true,
      )
  }
}

/** Centered single-line note for the facet's transient (loading) or empty states. */
@Composable
private fun NavigationFacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

/** Error state with a Retry affordance that re-runs the app-scoped navigation-graph pull. */
@Composable
private fun NavigationFacetError(message: String, onRetry: () -> Unit) {
  Column(
    Modifier.fillMaxSize(),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(message, color = MaterialTheme.colorScheme.error)
    Text(
      "Retry",
      color = MaterialTheme.colorScheme.primary,
      modifier =
        Modifier.padding(top = 8.dp).clickable(onClick = onRetry).semantics {
          contentDescription = "Retry loading navigation graph"
        },
    )
  }
}
