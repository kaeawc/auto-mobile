package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow

@Composable
internal fun ObserveTelemetry8(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(Unit) {
        snapshotFlow {
          FilterInputs(
            events.size,
            events.lastOrNull()?.timestamp,
            selectedFilter,
            debouncedQuery,
            enabledSeverities,
            isRegexEnabled,
            showBookmarksOnly,
            bookmarkedEvents.size,
          )
        }
          .collect {
            val source = if (showBookmarksOnly) bookmarkedEvents.toList() else events.toList()
            filteredEvents =
              buildFilteredList(
                source,
                selectedFilter,
                debouncedQuery,
                enabledSeverities,
                isRegexEnabled,
              )
          }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry9(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(filteredEvents.size) {
        val lastVisibleRow =
          if (selectedFilter == CategoryFilter.Network) {
            filteredEvents.lastIndex
          } else {
            renderedRows.lastIndex
          }
        if (autoScrollEnabled && !isPaused && lastVisibleRow >= 0) {
          listState.animateScrollToItem(lastVisibleRow)
        }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry10(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(selectedFilter) {
        lastSeenCounts[selectedFilter] = categoryCounts[selectedFilter] ?: 0
        onFilterChanged?.invoke(selectedFilter.timelineCategoryKey)
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry11(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(timelineState?.selectedTimestampMs) {
        val ts = timelineState?.selectedTimestampMs ?: return@LaunchedEffect
        val nearestIndex =
          if (selectedFilter == CategoryFilter.Network) {
            filteredEvents
              .indexOfFirst { event ->
                val end = event.timestamp + event.durationMs()
                ts in event.timestamp..end || event.timestamp >= ts
              }
              .takeIf { it >= 0 } ?: filteredEvents.lastIndex
          } else {
            groupedRowIndexForTimestamp(renderedRows, ts)
          }
        if (nearestIndex >= 0) {
          listState.animateScrollToItem(nearestIndex)
        }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry12(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(Unit) {
        snapshotFlow { listState.firstVisibleItemIndex }
          .collect { index ->
            if (timelineState == null) return@collect
            val visibleEvent =
              if (selectedFilter == CategoryFilter.Network) {
                filteredEvents.getOrNull(index)
              } else {
                renderedRows.getOrNull(index)?.event
              } ?: return@collect
            val eventTs = visibleEvent.timestamp
            // Only re-center if the event is outside the visible window
            if (eventTs < timelineState.visibleStartMs || eventTs > timelineState.visibleEndMs) {
              val halfDuration = timelineState.visibleDurationMs().coerceAtLeast(1L) / 2
              timelineState.visibleStartMs = eventTs - halfDuration
              timelineState.visibleEndMs =
                (eventTs + halfDuration).coerceAtLeast(timelineState.visibleStartMs + 1)
            }
          }
      }
    }
  }
}

@Composable
internal fun ObserveTelemetry13(options: TelemetryDashboardOptions, ui: TelemetryDashboardState) {
  with(options) {
    with(ui) {
      LaunchedEffect(filteredEvents.size) {
        if (listState.firstVisibleItemIndex <= 2) {
          listState.animateScrollToItem(0)
        }
      }
    }
  }
}
