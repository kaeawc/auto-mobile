package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationAppSummary
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.RealNavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboard
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("OfflineNavigationBrowser")

/** State of the app-list step of the offline browser. */
private sealed interface AppListState {
  data object Loading : AppListState

  data object Empty : AppListState

  data class Error(val message: String) : AppListState

  data class Loaded(val apps: List<NavigationAppSummary>) : AppListState
}

/** State of the per-app graph step once an app is selected. */
private sealed interface AppGraphState {
  data object Loading : AppGraphState

  data object Empty : AppGraphState

  data class Error(val message: String) : AppGraphState

  data class Resolved(val graph: NavigationGraph) : AppGraphState
}

/**
 * Offline navigation browser (Phase C of #4837). Reachable from the workspace empty state when **no
 * device is observed**: it lists apps that have a persisted navigation graph (via the
 * device-optional `automobile:navigation/apps` resource, read through
 * [NavigationDataSource.listApps]) and, on selecting one, renders that app's persisted graph
 * through the existing [NavigationDashboard] with `providedGraph` — no live device required.
 *
 * The dashboard is rendered `readOnly = true`: browsing, panning, zooming, and drilling into
 * screen/transition detail all work, but device-side navigate actions (which need a live device)
 * are unavailable and surfaced as disabled.
 *
 * [navigationDataSourceProvider] is injected (interface + fake) so the whole loading / empty /
 * error / resolved behavior is testable with a fake data source and no socket or MCP daemon. The
 * argument is the app id to scope a graph pull; it is `null` for the app-independent [listApps]
 * call.
 */
@Composable
fun OfflineNavigationBrowser(
  navigationDataSourceProvider: ((String?) -> NavigationDataSource)? = null,
  reloadTrigger: Int = 0,
) {
  val graph = LocalAutoMobileGraph.current
  val provider: (String?) -> NavigationDataSource =
    navigationDataSourceProvider
      ?: { appId ->
        RealNavigationDataSource(clientProvider = { graph.autoMobileClient }, appId = appId)
      }

  // Which app the user drilled into, if any. Null = show the app list.
  var selectedApp by remember { mutableStateOf<NavigationAppSummary?>(null) }

  if (selectedApp == null) {
    AppListStep(
      provider = provider,
      reloadTrigger = reloadTrigger,
      onSelect = { selectedApp = it },
    )
  } else {
    val app = selectedApp
    if (app != null) {
      AppGraphStep(app = app, provider = provider, onBack = { selectedApp = null })
    }
  }
}

@Composable
private fun AppListStep(
  provider: (String?) -> NavigationDataSource,
  reloadTrigger: Int,
  onSelect: (NavigationAppSummary) -> Unit,
) {
  var attempt by remember { mutableStateOf(0) }
  var state by remember { mutableStateOf<AppListState>(AppListState.Loading) }

  LaunchedEffect(reloadTrigger, attempt) {
    state = AppListState.Loading
    // Read off the UI thread: the resource read hits the daemon. Injected fakes run inline
    // (deterministic). A throw becomes a retryable Error rather than crashing the Recomposer.
    state =
      try {
        when (val result = withContext(Dispatchers.IO) { provider(null).listApps() }) {
          is Result.Success ->
            if (result.data.isEmpty()) AppListState.Empty else AppListState.Loaded(result.data)
          is Result.Error ->
            AppListState.Error(result.message ?: "Failed to load saved navigation graphs")
          Result.Loading -> AppListState.Error("Saved navigation graphs are still loading")
        }
      } catch (c: CancellationException) {
        throw c
      } catch (e: Exception) {
        LOG.warn("Offline app-list load failed: ${e.message}", e)
        AppListState.Error(e.message ?: "Failed to load saved navigation graphs")
      }
  }

  Column(Modifier.fillMaxSize()) {
    Text("Browse navigation history", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))
    Text(
      "Inspect a persisted navigation graph from a past session — no device required.",
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(12.dp))

    when (val current = state) {
      AppListState.Loading -> CenteredNote("Loading saved navigation graphs…")
      AppListState.Empty -> CenteredNote("No saved navigation graphs")
      is AppListState.Error ->
        RetryableError(
          message = current.message,
          retryContentDescription = "Retry loading saved navigation graphs",
        ) {
          attempt++
        }
      is AppListState.Loaded ->
        LazyColumn(
          Modifier.fillMaxSize(),
          verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          items(current.apps, key = { it.appId }) { app -> AppRow(app = app, onClick = onSelect) }
        }
    }
  }
}

@Composable
private fun AppRow(app: NavigationAppSummary, onClick: (NavigationAppSummary) -> Unit) {
  val label = app.displayName ?: app.appId
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .clickable { onClick(app) }
        .semantics { contentDescription = "Open navigation graph for $label" }
        .background(
          MaterialTheme.colorScheme.surfaceVariant,
          RoundedCornerShape(6.dp),
        )
        .padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(label, style = MaterialTheme.typography.bodyMedium)
      if (app.displayName != null) {
        Text(
          app.appId,
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }
    Text(
      app.lastUpdated,
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun AppGraphStep(
  app: NavigationAppSummary,
  provider: (String?) -> NavigationDataSource,
  onBack: () -> Unit,
) {
  val graph = LocalAutoMobileGraph.current
  var attempt by remember(app.appId) { mutableStateOf(0) }
  var state by remember(app.appId) { mutableStateOf<AppGraphState>(AppGraphState.Loading) }

  LaunchedEffect(app.appId, attempt) {
    state = AppGraphState.Loading
    state =
      try {
        when (
          val result = withContext(Dispatchers.IO) { provider(app.appId).getNavigationGraph() }
        ) {
          is Result.Success ->
            if (result.data.screens.isEmpty()) AppGraphState.Empty
            else AppGraphState.Resolved(result.data)
          is Result.Error ->
            AppGraphState.Error(result.message ?: "Failed to load navigation graph")
          Result.Loading -> AppGraphState.Error("Navigation graph is still loading")
        }
      } catch (c: CancellationException) {
        throw c
      } catch (e: Exception) {
        LOG.warn("Offline app-graph load failed: ${e.message}", e)
        AppGraphState.Error(e.message ?: "Failed to load navigation graph")
      }
  }

  // Remembered per app so its LRU screenshot cache survives recomposition.
  val screenshotLoader =
    remember(app.appId) {
      NavigationScreenshotLoader(clientProvider = { graph.autoMobileClient })
    }

  Column(Modifier.fillMaxSize()) {
    Row(
      Modifier.fillMaxWidth().padding(bottom = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        "← Back",
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier =
          Modifier.clickable(onClick = onBack)
            .semantics { contentDescription = "Back to saved navigation graphs" }
            .padding(horizontal = 8.dp, vertical = 4.dp),
      )
      Spacer(Modifier.weight(1f))
      Text(
        app.displayName ?: app.appId,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when (val current = state) {
        AppGraphState.Loading -> CenteredNote("Loading navigation graph…")
        AppGraphState.Empty -> CenteredNote("No navigation graph recorded for this app")
        is AppGraphState.Error ->
          RetryableError(
            message = current.message,
            retryContentDescription = "Retry loading navigation graph",
          ) {
            attempt++
          }
        is AppGraphState.Resolved ->
          NavigationDashboard(
            providedGraph = current.graph,
            screenshotLoader = screenshotLoader,
            settingsProvider = graph.settingsProvider,
            selectedAppId = app.appId,
            // Offline: device-side navigate actions are unavailable; browsing/panning still work.
            readOnly = true,
          )
      }
    }
  }
}

@Composable
private fun CenteredNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

@Composable
private fun RetryableError(
  message: String,
  retryContentDescription: String,
  onRetry: () -> Unit,
) {
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
          contentDescription = retryContentDescription
        },
    )
  }
}
