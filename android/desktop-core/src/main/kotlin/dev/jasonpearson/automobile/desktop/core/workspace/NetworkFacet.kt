package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkEndpointRow
import dev.jasonpearson.automobile.desktop.core.datasource.RealNetworkGraphDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private sealed interface NetworkFacetState {
  data object Loading : NetworkFacetState

  data object Empty : NetworkFacetState

  data class Error(val message: String) : NetworkFacetState

  data class Resolved(val rows: List<NetworkEndpointRow>) : NetworkFacetState
}

/**
 * Docked-facet body for [Tool.Network]: a first-cut flat list of the captured network endpoints for
 * a pane's device, read from the `getNetworkGraph` MCP tool. This is intentionally minimal — a flat
 * host/method/path list, not the full host → path tree dashboard.
 *
 * The graph read is injected via [loadNetworkGraph] so the loading/empty/error states are testable
 * without a live MCP daemon; the default reads through a [RealNetworkGraphDataSource] built from
 * the DI graph. The tool is embedded-SDK-only and returns an empty graph when no traffic was
 * captured, which is surfaced as an explicit empty state rather than an error.
 */
@Composable
fun NetworkFacet(
  column: DeviceColumn,
  loadNetworkGraph: (suspend (String) -> Result<List<NetworkEndpointRow>>)? = null,
) {
  val graph = LocalAutoMobileGraph.current
  val loader: suspend (String) -> Result<List<NetworkEndpointRow>> =
    loadNetworkGraph
      ?: { deviceId ->
        // Read off the UI thread: the tool call hits the daemon and would otherwise block
        // recomposition. Injected test loaders run inline (deterministic).
        withContext(Dispatchers.IO) {
          RealNetworkGraphDataSource({ graph.autoMobileClient }, deviceId).getNetworkGraph()
        }
      }
  var attempt by remember(column.deviceId) { mutableStateOf(0) }
  var state by
    remember(column.deviceId, attempt) {
      mutableStateOf<NetworkFacetState>(NetworkFacetState.Loading)
    }
  LaunchedEffect(column.deviceId, attempt) {
    state =
      when (val result = loader(column.deviceId)) {
        is Result.Success ->
          if (result.data.isEmpty()) NetworkFacetState.Empty
          else NetworkFacetState.Resolved(result.data)
        is Result.Error ->
          NetworkFacetState.Error(result.message ?: "Failed to load the network graph")
        // A one-shot tool call resolves to Success/Error; treat a stray Loading as retryable.
        Result.Loading -> NetworkFacetState.Error("Network graph is still loading")
      }
  }
  when (val current = state) {
    NetworkFacetState.Loading -> NetworkFacetNote("Loading network activity…")
    NetworkFacetState.Empty -> NetworkFacetNote("No network activity captured on this device")
    is NetworkFacetState.Error -> NetworkFacetError(current.message) { attempt++ }
    is NetworkFacetState.Resolved -> NetworkEndpointList(current.rows)
  }
}

/** Flat list of captured endpoints, one row per method+path. */
@Composable
private fun NetworkEndpointList(rows: List<NetworkEndpointRow>) {
  LazyColumn(Modifier.fillMaxSize().padding(8.dp)) {
    items(rows) { row -> NetworkEndpointRowItem(row) }
  }
}

@Composable
private fun NetworkEndpointRowItem(row: NetworkEndpointRow) {
  Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Row {
      Text(
        row.method ?: "—",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(end = 8.dp),
      )
      Text("${row.host}${row.path}", style = MaterialTheme.typography.bodyMedium)
    }
    Text(
      "✓ ${row.success}  ✗ ${row.errors}  p50 ${row.p50}ms  p95 ${row.p95}ms",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.outline,
    )
  }
}

/** Centered single-line note for the facet's transient (loading) or empty states. */
@Composable
private fun NetworkFacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

/** Error state with a Retry affordance that re-runs the network-graph load. */
@Composable
private fun NetworkFacetError(message: String, onRetry: () -> Unit) {
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
          contentDescription = "Retry loading network graph"
        },
    )
  }
}
