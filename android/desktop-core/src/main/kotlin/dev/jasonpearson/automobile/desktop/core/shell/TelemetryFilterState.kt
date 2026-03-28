package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * Shared state object for telemetry filters, used by both the center canvas
 * and bottom timeline for bidirectional sync.
 */
class TelemetryFilterState {
    /** Selected category names. Empty set means "all categories". */
    var selectedCategories: Set<String> by mutableStateOf(emptySet())

    /** Free-text search query (applied after debounce in the UI). */
    var searchQuery: String by mutableStateOf("")

    /** Visible time range in epoch millis. [LongRange.EMPTY] means unbounded. */
    var visibleTimeRange: LongRange by mutableStateOf(LongRange.EMPTY)

    /** When true, new incoming events are buffered but not displayed. */
    var isPaused: Boolean by mutableStateOf(false)
}

@Composable
fun rememberTelemetryFilterState(): TelemetryFilterState = remember { TelemetryFilterState() }
