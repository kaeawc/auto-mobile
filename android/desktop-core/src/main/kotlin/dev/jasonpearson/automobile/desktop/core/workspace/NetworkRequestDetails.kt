package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestDetail
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestRow
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestsDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext

/**
 * Detail pane for a selected row. Loads the full detail (headers) lazily off the summary row's id;
 * shows the summary immediately while the detail read is in flight so the pane never blanks.
 */
@Composable
internal fun NetworkRequestDetailPane(
  source: NetworkRequestsDataSource,
  row: NetworkRequestRow,
  ioDispatcher: CoroutineDispatcher,
) {
  var detail by remember(row.id) { mutableStateOf<Result<NetworkRequestDetail>>(Result.Loading) }
  LaunchedEffect(row.id) {
    detail = withContext(ioDispatcher) { source.getRequestDetail(row.id) }
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
