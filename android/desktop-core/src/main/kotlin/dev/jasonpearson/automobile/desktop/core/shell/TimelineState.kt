package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * State holder for the bottom timeline panel.
 * Tracks visible time range, zoom level, and selected event.
 */
class TimelineState {
    var visibleTimeRange: LongRange by mutableStateOf(LongRange.EMPTY)
    var zoomLevel: Float by mutableStateOf(1.0f)
    var selectedEventTimestamp: Long? by mutableStateOf(null)
}

@Composable
fun rememberTimelineState(): TimelineState = remember { TimelineState() }
