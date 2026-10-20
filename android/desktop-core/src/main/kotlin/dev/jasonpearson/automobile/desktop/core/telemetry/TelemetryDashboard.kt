package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons
import dev.jasonpearson.automobile.desktop.core.timeline.TimelineState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Telemetry dashboard showing a real-time scrollable event list with category filtering (Network,
 * Logs, OS, etc.).
 */
data class TelemetryDashboardOptions(
  val telemetryPushClient: TelemetryPushClient?,
  val dataSourceMode: DataSourceMode,
  val activeDeviceId: String? = null,
  val selectedEvent: TelemetryDisplayEvent? = null,
  val onEventSelected: (TelemetryDisplayEvent?) -> Unit = {},
  val timelineState: TimelineState? = null,
  val onFilterChanged: ((String?) -> Unit)? = null,
)

@Composable
fun TelemetryDashboard(
  options: TelemetryDashboardOptions,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  val ui = remember { TelemetryDashboardState(listState) }

  // Per-device event + count cache so switching devices preserves state

  // Incremental category counts — declared here so device switch can access them

  ObserveTelemetry1(options, ui)

  // Bookmarks (survives clear operations)

  // Event grouping expand/collapse state

  // Search and severity filter state

  // categoryCounts and lastSeenCounts declared above (before device switch LaunchedEffect)

  ObserveTelemetry2(options, ui)

  // Collect telemetry events from the push client (newest at bottom)
  // Track the latest timestamp from cached events to skip duplicates from backfill

  ObserveTelemetry3(options, ui)
  ObserveTelemetry4(options, ui)

  // Track whether user has scrolled away from the bottom (disables auto-scroll)
  ObserveTelemetry5(options, ui)

  // Collect connection state
  ObserveTelemetry6(options, ui)

  // Generate fake events in Fake mode
  ObserveTelemetry7(options, ui)

  // Recompute filtered list via snapshotFlow so filtering runs outside composition.
  ObserveTelemetry8(options, ui)

  // Grouped event list items for the LazyColumn

  // Auto-scroll to bottom when new events arrive
  ObserveTelemetry9(options, ui)

  // Mark current tab as seen when the selected filter changes
  ObserveTelemetry10(options, ui)

  // Sync: when timeline selection changes, scroll to nearest event
  ObserveTelemetry11(options, ui)

  // Sync: when telemetry scrolls, update timeline visible window center
  ObserveTelemetry12(options, ui)

  TelemetryDashboardContent(options, ui, modifier)

  // Auto-scroll to top when new events arrive and user is near top
  ObserveTelemetry13(options, ui)
}

/**
 * Data class used to trigger snapshotFlow recomputations when filter inputs change. [eventVersion]
 * captures both the size and a rolling change token so that add-then-trim cycles (where the buffer
 * stays the same size) still re-trigger filtering.
 */
@Composable
internal fun GroupHeader(
  categoryKey: String,
  count: Int,
  isExpanded: Boolean,
  textColor: Color,
  onClick: () -> Unit,
) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.04f))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 8.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Text(
      if (isExpanded) "\u25BC" else "\u25B6", // ▼ / ▶
      fontSize = 9.sp,
      color = textColor.copy(alpha = 0.6f),
    )
    Text(
      "$count $categoryKey events",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      fontWeight = FontWeight.SemiBold,
      color = textColor.copy(alpha = 0.7f),
    )
  }
}

internal data class EventRowOptions(
  val event: TelemetryDisplayEvent,
  val timeFormat: SimpleDateFormat,
  val textColor: Color,
  val isSelected: Boolean,
  val isBookmarked: Boolean,
  val onToggleBookmark: () -> Unit,
  val onClick: () -> Unit,
  val indented: Boolean = false,
)

@Composable
internal fun EventRowWithBookmark(options: EventRowOptions) {
  val event = options.event
  val timeFormat = options.timeFormat
  val textColor = options.textColor
  val isSelected = options.isSelected
  val isBookmarked = options.isBookmarked
  val onToggleBookmark = options.onToggleBookmark
  val onClick = options.onClick
  val indented = options.indented

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .then(if (isSelected) Modifier.background(textColor.copy(alpha = 0.08f)) else Modifier)
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(start = if (indented) 16.dp else 0.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.clickable(onClick = onToggleBookmark)
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(start = 4.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
    ) {
      Text(
        if (isBookmarked) "\u2605" else "\u2606",
        fontSize = 10.sp,
        color = if (isBookmarked) Color(0xFFFFD43B) else textColor.copy(alpha = 0.25f),
      )
    }
    Box(modifier = Modifier.weight(1f)) { TelemetryEventRow(event, timeFormat, textColor) }
  }
}

@Composable
private fun TelemetryEventRow(
  event: TelemetryDisplayEvent,
  timeFormat: SimpleDateFormat,
  textColor: Color,
) {
  val formattedTime = remember(event.timestamp) { timeFormat.format(Date(event.timestamp)) }

  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
    verticalAlignment = Alignment.Top,
  ) {
    // Timestamp
    Text(
      formattedTime,
      fontSize = 10.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.5f),
      maxLines = 1,
    )
    Spacer(Modifier.width(6.dp))

    // Category icon
    Icon(
      imageVector = telemetryEventIcon(event),
      contentDescription = null,
      modifier = Modifier.size(12.dp),
      tint = textColor.copy(alpha = 0.7f),
    )
    Spacer(Modifier.width(4.dp))

    // Summary text
    when (event) {
      is TelemetryDisplayEvent.Network -> NetworkSummary(event, textColor)
      is TelemetryDisplayEvent.Navigation -> NavigationSummary(event, textColor)
      is TelemetryDisplayEvent.Log -> LogSummary(event, textColor)
      is TelemetryDisplayEvent.Os -> OsSummary(event, textColor)
      is TelemetryDisplayEvent.Failure -> FailureSummary(event, textColor)
      is TelemetryDisplayEvent.Storage -> StorageSummary(event, textColor)
      is TelemetryDisplayEvent.Layout -> LayoutSummary(event, textColor)
      is TelemetryDisplayEvent.Performance -> PerformanceSummary(event, textColor)
      is TelemetryDisplayEvent.Memory -> MemorySummary(event, textColor)
      is TelemetryDisplayEvent.ToolCall -> ToolCallSummary(event, textColor)
      is TelemetryDisplayEvent.Accessibility -> A11ySummary(event, textColor)
    }
  }
}

internal fun networkStatusColor(statusCode: Int, error: String?, textColor: Color): Color =
  when {
    error != null || statusCode == 0 -> Color(0xFFFF6B6B) // Error / failed - bright red
    statusCode in 200..299 -> Color(0xFF51CF66) // 2xx success - bright green
    statusCode in 300..399 -> Color(0xFFFFD43B) // 3xx redirect - bright yellow
    statusCode >= 400 -> Color(0xFFFF6B6B) // 4xx/5xx - bright red
    else -> textColor.copy(alpha = 0.85f)
  }

@Composable
private fun NetworkSummary(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val color = networkStatusColor(event.statusCode, event.error, textColor)
  val displayPath = event.path ?: event.url

  Text(
    "${event.method} ${event.statusCode} $displayPath (${event.durationMs}ms)",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

private fun telemetryEventIcon(event: TelemetryDisplayEvent): ImageVector =
  when (event) {
    is TelemetryDisplayEvent.Network -> AppIcons.Network
    is TelemetryDisplayEvent.Navigation -> AppIcons.Navigation
    is TelemetryDisplayEvent.Log -> AppIcons.Logs
    is TelemetryDisplayEvent.Os -> AppIcons.Os
    is TelemetryDisplayEvent.Failure -> failureTelemetryIcon(event.type)
    is TelemetryDisplayEvent.Storage -> AppIcons.StorageCategory
    is TelemetryDisplayEvent.Layout -> AppIcons.Layout
    is TelemetryDisplayEvent.Performance -> AppIcons.Performance
    is TelemetryDisplayEvent.Memory -> AppIcons.Memory
    is TelemetryDisplayEvent.ToolCall -> AppIcons.ToolCalls
    is TelemetryDisplayEvent.Accessibility -> AppIcons.Accessibility
  }

private fun failureTelemetryIcon(type: String): ImageVector =
  when (type) {
    "crash" -> AppIcons.Crash
    "anr" -> AppIcons.Anr
    else -> AppIcons.NonFatal
  }

internal class TelemetryDashboardState(
  val listState: androidx.compose.foundation.lazy.LazyListState,
) {
  val deviceEventCache = mutableMapOf<String, List<TelemetryDisplayEvent>>()
  val deviceCountCache = mutableMapOf<String, Map<CategoryFilter, Int>>()
  val events = mutableStateListOf<TelemetryDisplayEvent>()
  val categoryCounts = mutableStateMapOf<CategoryFilter, Int>()
  val lastSeenCounts = mutableStateMapOf<CategoryFilter, Int>()
  var previousDeviceId by mutableStateOf<String?>(null)
  var selectedFilter by mutableStateOf(CategoryFilter.All)
  var connectionState by mutableStateOf<ConnectionState?>(null)
  val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
  var isPaused by mutableStateOf(false)
  var autoScrollEnabled by mutableStateOf(true)
  val bookmarkedEvents = mutableStateListOf<TelemetryDisplayEvent>()
  var showBookmarksOnly by mutableStateOf(false)
  val expandedGroups = mutableStateListOf<String>()
  var searchQuery by mutableStateOf("")
  var debouncedQuery by mutableStateOf("")
  var enabledSeverities by mutableStateOf(EventSeverity.entries.toSet())
  var isRegexEnabled by mutableStateOf(false)
  var maxEvents by mutableStateOf(DEFAULT_MAX_EVENTS)
  var showMaxEventsDropdown by mutableStateOf(false)
  var filteredEvents by mutableStateOf<List<TelemetryDisplayEvent>>(emptyList())
  val cachedMaxTimestamp = mutableStateOf(0L)
  val groupedItems by derivedStateOf { groupEvents(filteredEvents, expandedGroups.toSet()) }
  val renderedRows by derivedStateOf { buildRenderedRows(groupedItems) }
}
