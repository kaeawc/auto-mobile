package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
fun EventTimeline(
    events: List<TelemetryDisplayEvent>,
    state: TimelineState,
    activeFilterCategory: String?,
    onEventClicked: (TelemetryDisplayEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val filteredCategories by
      remember(activeFilterCategory) {
        derivedStateOf {
          if (activeFilterCategory == null) emptySet()
          else
              TimelineCategory.entries
                  .filter { it.label.equals(activeFilterCategory, ignoreCase = true) }
                  .toSet()
        }
      }
  val latestTimestamp = events.lastOrNull()?.timestamp ?: 0L
  val spans by
      remember(events.size, latestTimestamp, filteredCategories) {
        derivedStateOf { buildTimelineSpans(events, filteredCategories) }
      }
  val lanes by
      remember(spans) {
        derivedStateOf { activeLanes(spans) }
      }

  LaunchedEffect(spans.isNotEmpty()) {
    if (spans.isNotEmpty() && state.visibleStartMs == 0L && state.visibleEndMs == 1L) {
      state.fitToEvents(spans)
    }
  }

  if (events.isEmpty()) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Text("Event Timeline", color = colors.text.normal.copy(alpha = 0.5f), fontSize = 12.sp)
    }
  } else {
    Column(modifier.fillMaxSize()) {
      TimelineToolbar(
          state = state,
          spanCount = spans.size,
          onFitAll = { state.fitToEvents(spans) },
      )
      TimelineCanvas(
          spans = spans,
          activeLanes = lanes,
          state = state,
          onEventClicked = onEventClicked,
          modifier = Modifier.weight(1f).fillMaxWidth(),
      )
    }
  }
}
