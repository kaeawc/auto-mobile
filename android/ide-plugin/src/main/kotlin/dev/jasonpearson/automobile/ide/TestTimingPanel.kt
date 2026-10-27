package dev.jasonpearson.automobile.ide

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.project.Project
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingEntry
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingSummary
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.jetbrains.jewel.ui.component.DefaultButton
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.ListComboBox
import org.jetbrains.jewel.ui.component.OutlinedButton
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icon.PathIconKey

@Composable
fun TestTimingPanel(
  project: Project,
  client: AutoMobileClient,
  isConnected: Boolean,
  onShowNavigationGraph: () -> Unit,
) = TestTimingPanelWithDispatcher(project, client, isConnected, onShowNavigationGraph)

@Composable
private fun TestTimingPanelWithDispatcher(
  project: Project,
  client: AutoMobileClient,
  isConnected: Boolean,
  onShowNavigationGraph: () -> Unit,
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  val state = remember { TestTimingState() }
  val scope = rememberCoroutineScope()
  val refresh: suspend () -> Unit = { state.refreshTestTimings(client, isConnected, ioDispatcher) }
  TestTimingEffects(state, client, isConnected, refresh)
  TestTimingContent(
    state,
    rememberTestTimingPalette(),
    onRefresh = { scope.launch { refresh() } },
    onOpen = { entry ->
      state.selectedEntry = entry
      navigateToTest(project, entry) { message -> state.error = message }
    },
    onShowNavigationGraph = onShowNavigationGraph,
  )
}

@Composable
private fun TestTimingEffects(
  state: TestTimingState,
  client: AutoMobileClient,
  isConnected: Boolean,
  refreshTestTimings: suspend () -> Unit,
) =
  with(state) {
    LaunchedEffect(client, isConnected) {
      if (!isConnected) {
        summary = null
        timings = emptyList()
        status = "Not connected"
        error = null
        selectedEntry = null
        return@LaunchedEffect
      }
      refreshTestTimings()
    }

    val queryKey =
      "${lookbackDaysText.text.toString().trim()}:" +
        "${minSamplesText.text.toString().trim()}:" +
        "${limitText.text.toString().trim()}:${sortKey.name}:${sortDirection.name}"

    LaunchedEffect(autoPollEnabled, isConnected, client, queryKey) {
      if (!autoPollEnabled || !isConnected) {
        return@LaunchedEffect
      }
      while (isActive) {
        refreshTestTimings()
        delay(pollIntervalMs)
      }
    }
  }

@Composable
private fun rememberFilteredTimings(state: TestTimingState): List<TestTimingEntry> =
  with(state) {
    val filteredTimings =
      remember(timings, filterText.text, sortKey, sortDirection) {
        val filter = filterText.text.toString().trim().lowercase()
        val filtered =
          if (filter.isBlank()) {
            timings
          } else {
            timings.filter { entry ->
              val combined = "${entry.testClass}.${entry.testMethod}".lowercase()
              entry.testClass.lowercase().contains(filter) ||
                entry.testMethod.lowercase().contains(filter) ||
                combined.contains(filter)
            }
          }
        filtered.sortedWith(buildTestTimingComparator(sortKey, sortDirection))
      }

    filteredTimings
  }

@Composable
private fun TestTimingContent(
  state: TestTimingState,
  palette: TestTimingPalette,
  onRefresh: () -> Unit,
  onOpen: (TestTimingEntry) -> Unit,
  onShowNavigationGraph: () -> Unit,
) =
  with(state) {
    val filteredTimings = rememberFilteredTimings(state)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text("Test Timings")
      Text("Status: $status")
      if (error != null) Text("Error: ${error ?: ""}", color = palette.error)
      TestTimingQueryControls(state, onRefresh)
      TestTimingFilterControls(state)
      TestTimingSummary(filteredTimings, palette)
      SelectedTestTiming(state, palette, onShowNavigationGraph)
      TestTimingList(filteredTimings, palette, onOpen)
    }
  }

@Composable
private fun TestTimingQueryControls(state: TestTimingState, onRefresh: () -> Unit) =
  with(state) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      LabeledTextField(
        label = "Lookback days",
        state = lookbackDaysText,
        modifier = Modifier.width(140.dp),
      )
      LabeledTextField(
        label = "Min samples",
        state = minSamplesText,
        modifier = Modifier.width(120.dp),
      )
      LabeledTextField(
        label = "Limit",
        state = limitText,
        modifier = Modifier.width(100.dp),
      )
      OutlinedButton(onClick = { autoPollEnabled = !autoPollEnabled }) {
        Text(if (autoPollEnabled) "Pause polling" else "Resume polling")
      }
      DefaultButton(onClick = { onRefresh() }) { Text("Refresh") }
    }
  }

@Composable
private fun TestTimingFilterControls(state: TestTimingState) =
  with(state) {
    val sortOptions =
      listOf(
        TestTimingSortOption(TestTimingSortKey.AVG_DURATION, "Avg duration"),
        TestTimingSortOption(TestTimingSortKey.SAMPLE_SIZE, "Runs"),
        TestTimingSortOption(TestTimingSortKey.LAST_RUN, "Last run"),
        TestTimingSortOption(TestTimingSortKey.NAME, "Test name"),
      )
    val sortLabels = sortOptions.map { it.label }
    val selectedSortIndex = sortOptions.indexOfFirst { it.key == sortKey }.coerceAtLeast(0)

    val directionOptions =
      listOf(
        TestTimingDirectionOption(TestTimingSortDirection.DESC, "Desc"),
        TestTimingDirectionOption(TestTimingSortDirection.ASC, "Asc"),
      )
    val directionLabels = directionOptions.map { it.label }
    val selectedDirectionIndex =
      directionOptions.indexOfFirst { it.direction == sortDirection }.coerceAtLeast(0)

    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      LabeledTextField(
        label = "Filter (class/method)",
        state = filterText,
        modifier = Modifier.width(280.dp),
      )
      ListComboBox(
        sortLabels,
        selectedSortIndex,
        { index ->
          sortKey = sortOptions.getOrNull(index)?.key ?: TestTimingSortKey.AVG_DURATION
        },
      )
      ListComboBox(
        directionLabels,
        selectedDirectionIndex,
        { index ->
          sortDirection =
            directionOptions.getOrNull(index)?.direction ?: TestTimingSortDirection.DESC
        },
      )
      OutlinedButton(onClick = { filterText.setTextAndPlaceCursorAtEnd("") }) {
        Text("Clear filter")
      }
    }
  }

@Composable
private fun TestTimingSummary(filteredTimings: List<TestTimingEntry>, palette: TestTimingPalette) {
  val totalSamples = filteredTimings.sumOf { it.sampleSize }
  val totalPassed = filteredTimings.sumOf {
    it.statusCounts?.passed ?: (it.successRate * it.sampleSize).roundToInt()
  }
  val overallSuccessRate =
    if (totalSamples > 0) totalPassed.toDouble() / totalSamples.toDouble() else 0.0
  val averageDuration =
    if (filteredTimings.isNotEmpty()) {
      filteredTimings.map { it.averageDurationMs }.average()
    } else {
      0.0
    }

  Text(
    "Showing ${filteredTimings.size} tests | " +
      "Samples: $totalSamples | " +
      "Avg duration: ${formatDuration(averageDuration.roundToInt())} | " +
      "Success: ${formatRate(overallSuccessRate)}",
    color = palette.labelMuted,
    fontSize = 11.sp,
  )
  Text("Click a test row to open source.", color = palette.labelMuted, fontSize = 11.sp)
}

@Composable
private fun SelectedTestTiming(
  state: TestTimingState,
  palette: TestTimingPalette,
  onShowNavigationGraph: () -> Unit,
) =
  with(state) {
    val navigationIcon = remember {
      PathIconKey("icons/toolWindow.svg", AutoMobileToolWindowFactory::class.java)
    }
    selectedEntry?.let { entry ->
      Column(
        modifier = Modifier.fillMaxWidth().background(palette.detailBackground).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
          Text("Selected test", color = palette.labelMuted, fontSize = 11.sp)
          OutlinedButton(onClick = onShowNavigationGraph) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Icon(
                navigationIcon,
                contentDescription = "Show navigation graph",
                modifier = Modifier.width(14.dp).height(14.dp),
              )
              Spacer(modifier = Modifier.width(6.dp))
              Text("Show graph")
            }
          }
        }
        Text(
          "${entry.testClass}.${entry.testMethod}",
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          Text("Avg: ${formatDuration(entry.averageDurationMs)}")
          Text("Runs: ${entry.sampleSize}")
          Text("Success: ${formatRate(entry.successRate)}")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          Text("Std dev: ${entry.stdDevDurationMs?.let { formatDuration(it) } ?: "-"}")
          Text("Last run: ${formatTimestamp(entry.lastRun)}")
          Text("Status: ${formatStatusCounts(entry)}")
        }
      }
    }
  }

@Composable
private fun TestTimingList(
  filteredTimings: List<TestTimingEntry>,
  palette: TestTimingPalette,
  onOpen: (TestTimingEntry) -> Unit,
) {
  val maxDuration = filteredTimings.maxOfOrNull { it.averageDurationMs } ?: 0
  if (filteredTimings.isNotEmpty()) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      HeaderCell("Test", Modifier.weight(TEST_COL_WEIGHT), palette)
      HeaderCell("Avg", Modifier.weight(AVG_COL_WEIGHT), palette)
      HeaderCell("Runs", Modifier.weight(RUNS_COL_WEIGHT), palette)
      HeaderCell("Success", Modifier.weight(SUCCESS_COL_WEIGHT), palette)
      HeaderCell("Last run", Modifier.weight(LAST_RUN_COL_WEIGHT), palette)
    }

    LazyColumn(modifier = Modifier.fillMaxWidth().height(240.dp)) {
      items(filteredTimings, key = { "${it.testClass}#${it.testMethod}" }) { entry ->
        TestTimingRow(
          entry = entry,
          maxDuration = maxDuration,
          palette = palette,
          onOpen = {
            onOpen(entry)
          },
        )
      }
    }
  } else {
    Text("No test timing data available.", color = palette.labelMuted)
  }
}
