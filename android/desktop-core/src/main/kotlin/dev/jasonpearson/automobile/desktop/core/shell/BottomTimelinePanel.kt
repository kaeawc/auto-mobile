package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Top-level bottom timeline panel composing [TimelineRenderer] and [TimelineScreenshotOverlay].
 *
 * Shows a horizontal scrollable event timeline with screenshot thumbnails
 * above navigation events. Auto-scrolls to keep the latest events visible.
 */
@Composable
fun BottomTimelinePanel(
    events: List<TelemetryDisplayEvent>,
    timelineState: TimelineState,
    selectedEvent: TelemetryDisplayEvent?,
    onEventSelected: (TelemetryDisplayEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors

    LaunchedEffect(events.size) {
        if (events.isNotEmpty() && timelineState.visibleTimeRange.isEmpty()) {
            val latest = events.maxOf { it.timestamp }
            val earliest = events.minOf { it.timestamp }
            timelineState.visibleTimeRange = earliest..latest
        }
    }

    Column(modifier = modifier.height(120.dp).fillMaxWidth()) {
        HorizontalDivider(thickness = 1.dp, color = Color(0xFF3C3C3C))

        if (events.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "No events recorded yet",
                    color = colors.text.normal.copy(alpha = 0.5f),
                    fontSize = 11.sp,
                )
            }
        } else {
            val screenshotEvents = remember(events) {
                events.filterIsInstance<TelemetryDisplayEvent.Navigation>()
                    .filter { it.screenshotUri != null }
            }

            Box(modifier = Modifier.fillMaxSize()) {
                TimelineRenderer(
                    events = events,
                    timelineState = timelineState,
                    selectedEvent = selectedEvent,
                    onEventClicked = onEventSelected,
                    modifier = Modifier.fillMaxSize(),
                )

                if (screenshotEvents.isNotEmpty()) {
                    TimelineScreenshotOverlay(
                        screenshotEvents = screenshotEvents,
                        timelineState = timelineState,
                        onScreenshotClicked = { onEventSelected(it) },
                        modifier = Modifier.fillMaxWidth().height(84.dp),
                    )
                }
            }
        }
    }
}
