package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.matchesSearch

private const val MAX_EVENTS = 1000

/**
 * Top-level center pane composable that composes [EventFilterBar] + [UnifiedEventLog] vertically.
 * Collects events from the [telemetryPushClient] flow, applies [filterState] filters,
 * and passes the filtered list to the event log.
 */
@Composable
fun CenterCanvasPanel(
    telemetryPushClient: TelemetryPushClient?,
    filterState: TelemetryFilterState,
    selectedEvent: TelemetryDisplayEvent?,
    onEventSelected: (TelemetryDisplayEvent?) -> Unit,
    dataSourceMode: DataSourceMode,
    modifier: Modifier = Modifier,
) {
    val allEvents = remember { mutableStateListOf<TelemetryDisplayEvent>() }

    LaunchedEffect(telemetryPushClient) {
        val client = telemetryPushClient ?: return@LaunchedEffect
        client.telemetryEvents.collect { event ->
            if (!filterState.isPaused) {
                allEvents.add(event)
                while (allEvents.size > MAX_EVENTS) {
                    allEvents.removeAt(0)
                }
            }
        }
    }

    val filteredEvents by remember(filterState.selectedCategories, filterState.searchQuery) {
        derivedStateOf {
            var result: List<TelemetryDisplayEvent> = allEvents.toList()

            val categories = filterState.selectedCategories
            if (categories.isNotEmpty()) {
                result = result.filter { event -> eventCategoryName(event) in categories }
            }

            val range = filterState.visibleTimeRange
            if (!range.isEmpty()) {
                result = result.filter { it.timestamp in range }
            }

            val query = filterState.searchQuery
            if (query.isNotEmpty()) {
                result = result.filter { it.matchesSearch(query) }
            }

            result
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        EventFilterBar(filterState = filterState)
        UnifiedEventLog(
            events = filteredEvents,
            filterState = filterState,
            selectedEvent = selectedEvent,
            onEventSelected = onEventSelected,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * Maps a [TelemetryDisplayEvent] to its [EventCategory] name for filtering.
 */
private fun eventCategoryName(event: TelemetryDisplayEvent): String = when (event) {
    is TelemetryDisplayEvent.Network -> EventCategory.Network.name
    is TelemetryDisplayEvent.Navigation -> EventCategory.Navigation.name
    is TelemetryDisplayEvent.Log -> EventCategory.Logs.name
    is TelemetryDisplayEvent.Os -> EventCategory.Os.name
    is TelemetryDisplayEvent.Custom -> EventCategory.Custom.name
    is TelemetryDisplayEvent.Failure -> EventCategory.Failures.name
    is TelemetryDisplayEvent.Storage -> EventCategory.Storage.name
    is TelemetryDisplayEvent.Layout -> EventCategory.Layout.name
    is TelemetryDisplayEvent.Performance -> EventCategory.Performance.name
    is TelemetryDisplayEvent.ToolCall -> EventCategory.ToolCalls.name
    is TelemetryDisplayEvent.Memory -> EventCategory.Performance.name
    is TelemetryDisplayEvent.Accessibility -> EventCategory.Custom.name
}
