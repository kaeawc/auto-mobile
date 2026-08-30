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
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.storage.StorageDashboard
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * The package whose storage a pane inspects: the device's foreground app, else its first installed
 * app, else none. Pure so the choice is unit-testable.
 */
internal fun resolveStoragePackage(apps: List<InstalledApp>): String? =
  apps.firstOrNull { it.isForeground }?.packageName ?: apps.firstOrNull()?.packageName

/** Map the workspace [Platform] to the storage layer's [StoragePlatform]. */
internal fun Platform.toStoragePlatform(): StoragePlatform =
  if (this == Platform.Ios) StoragePlatform.iOS else StoragePlatform.Android

private sealed interface StorageFacetState {
  data object Loading : StorageFacetState

  data object NoApp : StorageFacetState

  data class Error(val message: String) : StorageFacetState

  data class Resolved(val packageName: String) : StorageFacetState
}

/**
 * Docked-facet body for [Tool.Storage]: the storage dashboard scoped to a pane's device and its
 * resolved app. The app is auto-resolved (foreground, else first installed) via
 * [loadInstalledApps], which is injected so resolution and its loading/error/empty states are
 * testable without real MCP; the default reads the device's installed-app list through the DI
 * graph. An app-list failure surfaces a retryable error rather than being masked as "no app".
 *
 * While the dashboard is shown, a per-pane [ObservationStream] created via
 * [observationStreamFactory] is connected to [column]'s device so live `storage_update` frames flow
 * into the key-value inspector (issue #4709), mirroring how [PerformanceFacet] drives its metrics.
 * The stream reconnects automatically if it drops while the facet is open (see
 * [rememberReconnectingObservationStream]); the factory, [backoffDelay], and [socketAvailable] are
 * injected so the per-device connect/dispose lifecycle can be verified with a
 * [FakeObservationStream] and virtual time. Because each pane resolves its own device-scoped
 * stream, panes in a multi-device workspace stay isolated (the dashboard also filters updates to
 * [column]'s device and app).
 */
@Composable
fun StorageFacet(
  column: DeviceColumn,
  loadInstalledApps: (suspend (String) -> Result<List<InstalledApp>>)? = null,
  observationStreamFactory: (String) -> ObservationStream = { ObservationStreamClient() },
  backoffDelay: suspend (attempt: Int) -> Unit = { attempt -> delay(reconnectBackoffMs(attempt)) },
  socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
) {
  val graph = LocalAutoMobileGraph.current
  val loader: suspend (String) -> Result<List<InstalledApp>> =
    loadInstalledApps
      ?: { deviceId ->
        // Resolve off the UI thread: the app-list read hits the daemon and would otherwise block
        // recomposition. Injected test loaders run inline (deterministic).
        withContext(Dispatchers.IO) {
          graph.dataSourceFactory
            .createAppListDataSource(DataSourceMode.Real, { graph.autoMobileClient }, deviceId)
            .getInstalledApps()
        }
      }
  var attempt by remember(column.deviceId) { mutableStateOf(0) }
  var state by
    remember(column.deviceId, attempt) {
      mutableStateOf<StorageFacetState>(StorageFacetState.Loading)
    }
  LaunchedEffect(column.deviceId, attempt) {
    state =
      when (val result = loader(column.deviceId)) {
        is Result.Success ->
          resolveStoragePackage(result.data)?.let { StorageFacetState.Resolved(it) }
            ?: StorageFacetState.NoApp
        is Result.Error ->
          StorageFacetState.Error(result.message ?: "Failed to load the device's apps")
        // A one-shot app-list load resolves to Success/Error; treat a stray Loading as retryable
        // rather than leaving the facet stuck on "Resolving app…".
        Result.Loading -> StorageFacetState.Error("App list is still loading")
      }
  }
  when (val current = state) {
    StorageFacetState.Loading -> FacetNote("Resolving app…")
    StorageFacetState.NoApp -> FacetNote("No app found on this device")
    is StorageFacetState.Error -> FacetError(current.message) { attempt++ }
    is StorageFacetState.Resolved -> {
      // Per-pane, device-scoped stream with automatic reconnect; lives only while the dashboard is
      // shown (disposed when this branch leaves composition or the device changes).
      val stream =
        rememberReconnectingObservationStream(
          deviceId = column.deviceId,
          streamFactory = { observationStreamFactory(column.deviceId) },
          backoffDelay = backoffDelay,
          socketAvailable = socketAvailable,
        )
      StorageDashboard(
        dataSourceMode = DataSourceMode.Real,
        clientProvider = { graph.autoMobileClient },
        deviceId = column.deviceId,
        packageName = current.packageName,
        platform = column.platform.toStoragePlatform(),
        observationStreamClient = stream,
      )
    }
  }
}

/** Centered single-line note for a facet's transient (resolving) or empty states. */
@Composable
private fun FacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

/** Error state with a Retry affordance that re-runs the app-list load. */
@Composable
private fun FacetError(message: String, onRetry: () -> Unit) {
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
          contentDescription = "Retry loading apps"
        },
    )
  }
}
