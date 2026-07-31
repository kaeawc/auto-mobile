package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestDetail
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestRow
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestsDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.RealNetworkRequestsDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private sealed interface NetworkFacetState {
  data object Loading : NetworkFacetState

  data object Empty : NetworkFacetState

  data class Error(val message: String) : NetworkFacetState

  data class Resolved(val rows: List<NetworkRequestRow>) : NetworkFacetState
}

/**
 * Docked-facet body for [Tool.Network]: a per-request table (method · host/path · status · timing)
 * with a detail pane (headers/timing) for the selected row. Reads the daemon's
 * `automobile:network/traffic` resource scoped to the pane's device — the per-request event log,
 * not the aggregated `getNetworkGraph` tree.
 *
 * The data source is injected via [dataSource] so the loading/empty/error/selection states are
 * testable without a live MCP daemon; the default reads through a [RealNetworkRequestsDataSource]
 * built from the DI graph and scoped to [DeviceColumn.deviceId]. Everything is keyed on the device
 * id so switching panes never bleeds one device's traffic into another.
 *
 * This is a one-shot fetch of the latest N requests; live streaming of new requests and the
 * correlation/events strip (frame 03 lower region) are tracked as follow-ups.
 */
@Composable
fun NetworkFacet(column: DeviceColumn, dataSource: NetworkRequestsDataSource? = null) {
  val graph = LocalAutoMobileGraph.current
  val source: NetworkRequestsDataSource =
    remember(column.deviceId, dataSource) {
      dataSource ?: RealNetworkRequestsDataSource({ graph.autoMobileClient }, column.deviceId)
    }

  var attempt by remember(column.deviceId) { mutableStateOf(0) }
  var state by
    remember(column.deviceId, attempt) {
      mutableStateOf<NetworkFacetState>(NetworkFacetState.Loading)
    }
  var selectedId by remember(column.deviceId, attempt) { mutableStateOf<Long?>(null) }

  LaunchedEffect(column.deviceId, attempt) {
    // Read off the UI thread: the resource read hits the daemon and would otherwise block
    // recomposition. Injected test data sources run inline (deterministic).
    state =
      when (val result = withContext(Dispatchers.IO) { source.getRequests() }) {
        is Result.Success ->
          if (result.data.isEmpty()) NetworkFacetState.Empty
          else NetworkFacetState.Resolved(result.data)
        is Result.Error ->
          NetworkFacetState.Error(result.message ?: "Failed to load network requests")
        // A one-shot read resolves to Success/Error; treat a stray Loading as retryable.
        Result.Loading -> NetworkFacetState.Error("Network requests are still loading")
      }
  }

  when (val current = state) {
    NetworkFacetState.Loading -> NetworkFacetNote("Loading network activity…")
    NetworkFacetState.Empty -> NetworkFacetNote("No network activity captured on this device")
    is NetworkFacetState.Error -> NetworkFacetError(current.message) { attempt++ }
    is NetworkFacetState.Resolved ->
      NetworkRequestsBody(
        rows = current.rows,
        source = source,
        selectedId = selectedId,
        onSelect = { selectedId = it },
      )
  }
}

/** Split view: a selectable request table on the left, the selected row's detail on the right. */
@Composable
private fun NetworkRequestsBody(
  rows: List<NetworkRequestRow>,
  source: NetworkRequestsDataSource,
  selectedId: Long?,
  onSelect: (Long) -> Unit,
) {
  Row(Modifier.fillMaxSize()) {
    Box(Modifier.weight(1f).fillMaxHeight()) {
      NetworkRequestTable(rows = rows, selectedId = selectedId, onSelect = onSelect)
    }
    Box(Modifier.weight(1f).fillMaxHeight().padding(8.dp)) {
      val selected = rows.firstOrNull { it.id == selectedId }
      if (selected == null) {
        NetworkFacetNote("Select a request to inspect headers and timing")
      } else {
        NetworkRequestDetailPane(source = source, row = selected)
      }
    }
  }
}

/** Selectable table, one row per captured request. */
@Composable
private fun NetworkRequestTable(
  rows: List<NetworkRequestRow>,
  selectedId: Long?,
  onSelect: (Long) -> Unit,
) {
  LazyColumn(Modifier.fillMaxSize().padding(8.dp)) {
    items(rows, key = { it.id }) { row ->
      NetworkRequestRowItem(
        row = row,
        selected = row.id == selectedId,
        onSelect = { onSelect(row.id) },
      )
    }
  }
}

@Composable
private fun NetworkRequestRowItem(row: NetworkRequestRow, selected: Boolean, onSelect: () -> Unit) {
  val background =
    if (selected) MaterialTheme.colorScheme.secondaryContainer
    else MaterialTheme.colorScheme.surface
  Row(
    Modifier.fillMaxWidth()
      .background(background)
      .clickable(onClick = onSelect)
      .semantics { contentDescription = "Network request ${row.method} ${row.host}${row.path}" }
      .padding(vertical = 6.dp, horizontal = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      row.method,
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.primary,
      modifier = Modifier.width(52.dp),
    )
    Text(
      "${row.host}${row.path}",
      style = MaterialTheme.typography.bodyMedium,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
    )
    Text(
      statusLabel(row),
      style = MaterialTheme.typography.labelMedium,
      color = statusColor(row),
      modifier = Modifier.width(44.dp),
    )
    Text(
      "${row.durationMs}ms",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.outline,
      modifier = Modifier.width(64.dp),
    )
  }
}

/** A dash for an in-flight/uncaptured status (0); otherwise the numeric code. */
private fun statusLabel(row: NetworkRequestRow): String =
  if (row.statusCode == 0) "—" else row.statusCode.toString()

@Composable
private fun statusColor(row: NetworkRequestRow) =
  if (row.statusCode >= 400 || row.error != null) MaterialTheme.colorScheme.error
  else MaterialTheme.colorScheme.onSurface

/**
 * Detail pane for a selected row. Loads the full detail (headers) lazily off the summary row's id;
 * shows the summary immediately while the detail read is in flight so the pane never blanks.
 */
@Composable
private fun NetworkRequestDetailPane(source: NetworkRequestsDataSource, row: NetworkRequestRow) {
  var detail by remember(row.id) { mutableStateOf<Result<NetworkRequestDetail>>(Result.Loading) }
  LaunchedEffect(row.id) {
    detail = withContext(Dispatchers.IO) { source.getRequestDetail(row.id) }
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Text(
      "${row.method} ${row.host}${row.path}",
      style = MaterialTheme.typography.titleSmall,
      modifier = Modifier.semantics { contentDescription = "Selected request detail" },
    )
    Text(
      "${statusLabel(row)} · ${row.durationMs}ms",
      style = MaterialTheme.typography.labelMedium,
      color = statusColor(row),
      modifier = Modifier.padding(top = 2.dp),
    )
    row.error?.let {
      Text(
        it,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.padding(top = 4.dp),
      )
    }

    when (val current = detail) {
      Result.Loading -> DetailNote("Loading request detail…")
      is Result.Error -> DetailNote(current.message ?: "Failed to load request detail")
      is Result.Success -> {
        val data = current.data
        data.contentType?.let { HeaderLine("Content-Type", it) }
        data.protocol?.let { HeaderLine("Protocol", it) }
        HeaderSection("Request headers", data.requestHeaders)
        HeaderSection("Response headers", data.responseHeaders)
      }
    }
  }
}

@Composable
private fun DetailNote(text: String) {
  Text(
    text,
    style = MaterialTheme.typography.bodySmall,
    color = MaterialTheme.colorScheme.outline,
    modifier = Modifier.padding(top = 8.dp),
  )
}

@Composable
private fun HeaderSection(title: String, headers: Map<String, String>) {
  Text(
    title,
    style = MaterialTheme.typography.labelLarge,
    color = MaterialTheme.colorScheme.primary,
    modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
  )
  if (headers.isEmpty()) {
    DetailNote("None")
  } else {
    for ((name, value) in headers) {
      HeaderLine(name, value)
    }
  }
}

@Composable
private fun HeaderLine(name: String, value: String) {
  Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
    Text(
      "$name:",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.outline,
      modifier = Modifier.width(120.dp),
    )
    Text(value, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
  }
}

/** Centered single-line note for the facet's transient (loading) or empty states. */
@Composable
private fun NetworkFacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

/** Error state with a Retry affordance that re-runs the network requests load. */
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
          contentDescription = "Retry loading network requests"
        },
    )
  }
}
