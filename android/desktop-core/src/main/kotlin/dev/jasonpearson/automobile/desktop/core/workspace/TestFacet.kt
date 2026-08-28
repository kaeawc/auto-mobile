package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import dev.jasonpearson.automobile.desktop.core.datasource.RealTestDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.datasource.TestDataSource
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.test.TestRun
import dev.jasonpearson.automobile.desktop.core.test.TestStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private sealed interface TestFacetState {
  data object Loading : TestFacetState

  data object Empty : TestFacetState

  data class Error(val message: String) : TestFacetState

  data class Resolved(val runs: List<TestRun>) : TestFacetState
}

/**
 * Docked-facet body for [Tool.Test]: the pane device's recent test runs (name · status · device ·
 * duration), most recent first. Reads the daemon's `automobile:test-runs?deviceId=<id>` resource
 * scoped to the pane's device (via [RealTestDataSource] / [TestDataSource.getTestRuns]) so each
 * device column shows only its own runs — the per-device consumer of the resource shape landed
 * in #4715 / #5017.
 *
 * The data source is injected via [dataSource] so the loading/empty/error states are testable
 * without a live MCP daemon; the default reads through a [RealTestDataSource] built from the DI
 * graph and scoped to [DeviceColumn.deviceId]. Everything is keyed on the device id so switching
 * panes never bleeds one device's runs into another.
 *
 * This is a one-shot fetch of the latest runs; the full recording/detail flow remains the
 * standalone Test dashboard.
 */
@Composable
fun TestFacet(column: DeviceColumn, dataSource: TestDataSource? = null) {
  val graph = LocalAutoMobileGraph.current
  val source: TestDataSource =
    remember(column.deviceId, dataSource) {
      dataSource ?: RealTestDataSource({ graph.autoMobileClient }, column.deviceId)
    }

  var attempt by remember(column.deviceId) { mutableStateOf(0) }
  var state by
    remember(column.deviceId, attempt) { mutableStateOf<TestFacetState>(TestFacetState.Loading) }

  LaunchedEffect(column.deviceId, attempt) {
    // Read off the UI thread: the resource read hits the daemon and would otherwise block
    // recomposition. Injected test data sources run inline (deterministic).
    state =
      when (val result = withContext(Dispatchers.IO) { source.getTestRuns() }) {
        is Result.Success ->
          if (result.data.isEmpty()) TestFacetState.Empty else TestFacetState.Resolved(result.data)
        is Result.Error -> TestFacetState.Error(result.message ?: "Failed to load test runs")
        // A one-shot read resolves to Success/Error; treat a stray Loading as retryable.
        Result.Loading -> TestFacetState.Error("Test runs are still loading")
      }
  }

  when (val current = state) {
    TestFacetState.Loading -> TestFacetNote("Loading test runs…")
    TestFacetState.Empty -> TestFacetNote("No test runs for this device")
    is TestFacetState.Error -> TestFacetError(current.message) { attempt++ }
    is TestFacetState.Resolved -> TestRunList(current.runs)
  }
}

/** One row per test run, most recent first. */
@Composable
private fun TestRunList(runs: List<TestRun>) {
  val sorted = remember(runs) { runs.sortedByDescending { it.startTime } }
  LazyColumn(Modifier.fillMaxSize().padding(8.dp)) {
    items(sorted, key = { it.id }) { run -> TestRunRowItem(run) }
  }
}

@Composable
private fun TestRunRowItem(run: TestRun) {
  Row(
    Modifier.fillMaxWidth()
      .semantics { contentDescription = "Test run ${run.testName} ${statusLabel(run.status)}" }
      .padding(vertical = 6.dp, horizontal = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(Modifier.size(8.dp).background(statusColor(run.status), CircleShape))
    Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
      Text(
        run.testName,
        style = MaterialTheme.typography.bodyMedium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        run.deviceName,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.outline,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Text(
      statusLabel(run.status),
      style = MaterialTheme.typography.labelMedium,
      color = statusColor(run.status),
      modifier = Modifier.width(64.dp),
    )
    Text(
      "${run.durationMs / 1000.0}s",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.outline,
      modifier = Modifier.width(56.dp),
    )
  }
}

private fun statusLabel(status: TestStatus): String =
  when (status) {
    TestStatus.Passed -> "Passed"
    TestStatus.Failed -> "Failed"
    TestStatus.Running -> "Running"
    TestStatus.Skipped -> "Skipped"
  }

@Composable
private fun statusColor(status: TestStatus) =
  when (status) {
    TestStatus.Failed -> MaterialTheme.colorScheme.error
    TestStatus.Passed -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.onSurface
  }

/** Centered single-line note for the facet's transient (loading) or empty states. */
@Composable
private fun TestFacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

/** Error state with a Retry affordance that re-runs the test-runs load. */
@Composable
private fun TestFacetError(message: String, onRetry: () -> Unit) {
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
          contentDescription = "Retry loading test runs"
        },
    )
  }
}
