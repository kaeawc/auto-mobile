package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
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
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.core.timeline.TimelineState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val GROUP_THRESHOLD = 3

/** Returns a category key used to group consecutive same-type events. */
private fun TelemetryDisplayEvent.categoryKey(): String =
    when (this) {
      is TelemetryDisplayEvent.Network -> "Network"
      is TelemetryDisplayEvent.Navigation -> "Navigation"
      is TelemetryDisplayEvent.Log -> "Log"
      is TelemetryDisplayEvent.Os -> "OS"
      is TelemetryDisplayEvent.Failure -> "Failure"
      is TelemetryDisplayEvent.Storage -> "Storage"
      is TelemetryDisplayEvent.Layout -> "Layout"
      is TelemetryDisplayEvent.Performance -> "Performance"
      is TelemetryDisplayEvent.Memory -> "Memory"
      is TelemetryDisplayEvent.ToolCall -> "ToolCall"
      is TelemetryDisplayEvent.Accessibility -> "Accessibility"
    }

/**
 * A row in the event list: either a single event or a collapsible group of 3+ consecutive same-type
 * events.
 */
private sealed class EventListItem {
  data class Single(val event: TelemetryDisplayEvent) : EventListItem()

  data class Group(
      val categoryKey: String,
      val events: List<TelemetryDisplayEvent>,
      val isExpanded: Boolean,
  ) : EventListItem()
}

private data class RenderedTelemetryRow(
    val event: TelemetryDisplayEvent,
    val startTimestamp: Long,
    val endTimestamp: Long,
)

/**
 * Processes a flat event list into [EventListItem]s, collapsing runs of 3+ consecutive
 * same-category events into groups.
 */
private fun groupEvents(
    events: List<TelemetryDisplayEvent>,
    expandedGroups: Set<String>,
): List<EventListItem> {
  if (events.isEmpty()) return emptyList()
  val result = mutableListOf<EventListItem>()
  var runStart = 0
  while (runStart < events.size) {
    val key = events[runStart].categoryKey()
    var runEnd = runStart + 1
    while (runEnd < events.size && events[runEnd].categoryKey() == key) {
      runEnd++
    }
    if (runEnd - runStart >= GROUP_THRESHOLD) {
      val groupId = key
      val expanded = groupId in expandedGroups
      result.add(
          EventListItem.Group(
              categoryKey = key,
              events = events.subList(runStart, runEnd),
              isExpanded = expanded,
          )
      )
    } else {
      for (i in runStart until runEnd) {
        result.add(EventListItem.Single(events[i]))
      }
    }
    runStart = runEnd
  }
  return result
}

private const val DETAIL_PANEL_WIDTH_KEY = "automobile.telemetry.detailPanelWidth"
private const val DETAIL_PANEL_WIDTH_DEFAULT = 320
private const val DETAIL_PANEL_WIDTH_MIN = 200
private const val DETAIL_PANEL_WIDTH_MAX = 600

/** Allowed max-event buffer sizes for the telemetry dashboard. */
internal val MAX_EVENTS_OPTIONS = listOf(500, 1000, 5000, 10_000)
private const val DEFAULT_MAX_EVENTS = 1000

private enum class CategoryFilter(
    val label: String,
    val timelineCategoryKey: String?,
    val icon: ImageVector,
) {
  All("All", null, AppIcons.All),
  Network("Network", "Network", AppIcons.Network),
  Navigation("Nav", "Navigation", AppIcons.Navigation),
  Logs("Logs", "Log", AppIcons.Logs),
  Os("OS", "Os", AppIcons.Os),
  Failures("Failures", "Failure", AppIcons.Failures),
  Storage("Storage", "Storage", AppIcons.StorageCategory),
  Layout("Layout", "Layout", AppIcons.Layout),
  Performance("Perf", "Performance", AppIcons.Performance),
  ToolCalls("Tools", "ToolCall", AppIcons.ToolCalls),
}

/** Returns the duration of a telemetry event in milliseconds, or 0 for point events. */
private fun TelemetryDisplayEvent.durationMs(): Long =
    when (this) {
      is TelemetryDisplayEvent.Network -> durationMs
      is TelemetryDisplayEvent.ToolCall -> durationMs
      is TelemetryDisplayEvent.Layout -> durationMs ?: 0L
      else -> 0L
    }

private fun groupedRowIndexForTimestamp(
    renderedRows: List<RenderedTelemetryRow>,
    timestamp: Long,
): Int {
  val nearestRow = renderedRows.indexOfFirst { row ->
    timestamp in row.startTimestamp..row.endTimestamp || row.startTimestamp >= timestamp
  }
  return if (nearestRow >= 0) nearestRow else renderedRows.lastIndex
}

private fun buildRenderedRows(groupedItems: List<EventListItem>): List<RenderedTelemetryRow> =
    buildList {
      groupedItems.forEach { listItem ->
        when (listItem) {
          is EventListItem.Single -> {
            val dur = listItem.event.durationMs()
            add(
                RenderedTelemetryRow(
                    event = listItem.event,
                    startTimestamp = listItem.event.timestamp,
                    endTimestamp = listItem.event.timestamp + dur,
                )
            )
          }
          is EventListItem.Group -> {
            val firstEvent = listItem.events.firstOrNull() ?: return@forEach
            val lastEvent = listItem.events.lastOrNull() ?: firstEvent
            // When expanded, restrict header range so child rows are reachable
            // by timestamp lookup; when collapsed, span the full group range.
            val headerEnd = if (listItem.isExpanded) firstEvent.timestamp else lastEvent.timestamp
            add(
                RenderedTelemetryRow(
                    event = firstEvent,
                    startTimestamp = firstEvent.timestamp,
                    endTimestamp = headerEnd,
                )
            )
            if (listItem.isExpanded) {
              listItem.events.forEach { event ->
                val dur = event.durationMs()
                add(
                    RenderedTelemetryRow(
                        event = event,
                        startTimestamp = event.timestamp,
                        endTimestamp = event.timestamp + dur,
                    )
                )
              }
            }
          }
        }
      }
    }

/**
 * Telemetry dashboard showing a real-time scrollable event list with category filtering (Network,
 * Logs, OS, etc.).
 */
@Composable
fun TelemetryDashboard(
    telemetryPushClient: TelemetryPushClient?,
    dataSourceMode: DataSourceMode,
    activeDeviceId: String? = null,
    selectedEvent: TelemetryDisplayEvent? = null,
    onEventSelected: (TelemetryDisplayEvent?) -> Unit = {},
    timelineState: TimelineState? = null,
    onFilterChanged: ((String?) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  // Per-device event + count cache so switching devices preserves state
  val deviceEventCache = remember { mutableMapOf<String, List<TelemetryDisplayEvent>>() }
  val deviceCountCache = remember { mutableMapOf<String, Map<CategoryFilter, Int>>() }
  val events = remember { mutableStateListOf<TelemetryDisplayEvent>() }
  // Incremental category counts — declared here so device switch can access them
  val categoryCounts = remember { mutableStateMapOf<CategoryFilter, Int>() }
  val lastSeenCounts = remember { mutableStateMapOf<CategoryFilter, Int>() }
  var previousDeviceId by remember { mutableStateOf<String?>(null) }
  LaunchedEffect(activeDeviceId) {
    // Save current events + counts to cache before switching
    if (previousDeviceId != null && events.isNotEmpty()) {
      deviceEventCache[previousDeviceId!!] = events.toList()
      deviceCountCache[previousDeviceId!!] = categoryCounts.toMap()
    }
    // Restore cached events + counts for the new device, or clear
    events.clear()
    categoryCounts.clear()
    lastSeenCounts.clear()
    val cached = activeDeviceId?.let { deviceEventCache[it] }
    if (cached != null) {
      events.addAll(cached)
    }
    val cachedCounts = activeDeviceId?.let { deviceCountCache[it] }
    if (cachedCounts != null) {
      categoryCounts.putAll(cachedCounts)
    }
    previousDeviceId = activeDeviceId
  }
  var selectedFilter by remember { mutableStateOf(CategoryFilter.All) }
  var connectionState by remember { mutableStateOf<ConnectionState?>(null) }
  val listState = rememberLazyListState()
  val timeFormat = remember { SimpleDateFormat("HH:mm:ss.SSS", Locale.US) }
  var isPaused by remember { mutableStateOf(false) }
  var autoScrollEnabled by remember { mutableStateOf(true) }

  // Bookmarks (survives clear operations)
  val bookmarkedEvents = remember { mutableStateListOf<TelemetryDisplayEvent>() }
  var showBookmarksOnly by remember { mutableStateOf(false) }

  // Event grouping expand/collapse state
  val expandedGroups = remember { mutableStateListOf<String>() }

  // Search and severity filter state
  var searchQuery by remember { mutableStateOf("") }
  var debouncedQuery by remember { mutableStateOf("") }
  var enabledSeverities by remember { mutableStateOf(EventSeverity.entries.toSet()) }
  var isRegexEnabled by remember { mutableStateOf(false) }

  var maxEvents by remember { mutableStateOf(DEFAULT_MAX_EVENTS) }
  var showMaxEventsDropdown by remember { mutableStateOf(false) }

  // categoryCounts and lastSeenCounts declared above (before device switch LaunchedEffect)

  var filteredEvents by remember { mutableStateOf<List<TelemetryDisplayEvent>>(emptyList()) }

  LaunchedEffect(searchQuery) {
    delay(150)
    debouncedQuery = searchQuery
  }

  // Collect telemetry events from the push client (newest at bottom)
  // Track the latest timestamp from cached events to skip duplicates from backfill
  val cachedMaxTimestamp = remember { mutableStateOf(0L) }
  LaunchedEffect(activeDeviceId) {
    cachedMaxTimestamp.value = events.maxOfOrNull { it.timestamp } ?: 0L
  }
  LaunchedEffect(telemetryPushClient, isPaused) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.telemetryEvents.collect { event ->
      if (!isPaused) {
        // Skip events we already have from cache restore
        if (
            event.timestamp <= cachedMaxTimestamp.value &&
                events.any { it.timestamp == event.timestamp && it::class == event::class }
        ) {
          return@collect
        }
        events.add(event)
        incrementCount(categoryCounts, event)
        trimEvents(events, maxEvents, categoryCounts)
      }
    }
  }

  // Track whether user has scrolled away from the bottom (disables auto-scroll)
  LaunchedEffect(Unit) {
    snapshotFlow {
      val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
      val totalItems = listState.layoutInfo.totalItemsCount
      totalItems - lastVisible <= 3
    }
        .collect { nearBottom ->
          autoScrollEnabled = nearBottom
        }
  }

  // Collect connection state
  LaunchedEffect(telemetryPushClient) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.connectionState.collect { state -> connectionState = state }
  }

  // Generate fake events in Fake mode
  LaunchedEffect(dataSourceMode) {
    if (dataSourceMode != DataSourceMode.Fake) return@LaunchedEffect
    val fakeEvents = generateFakeEvents()
    events.addAll(fakeEvents)
    // Initialize incremental counts from bulk-added fake events
    categoryCounts[CategoryFilter.All] = (categoryCounts[CategoryFilter.All] ?: 0) + fakeEvents.size
    for (e in fakeEvents) {
      val cat = categoryOf(e) ?: continue
      categoryCounts[cat] = (categoryCounts[cat] ?: 0) + 1
    }
  }

  // Recompute filtered list via snapshotFlow so filtering runs outside composition.
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

  // Grouped event list items for the LazyColumn
  val groupedItems by remember {
    derivedStateOf { groupEvents(filteredEvents, expandedGroups.toSet()) }
  }
  val renderedRows by remember { derivedStateOf { buildRenderedRows(groupedItems) } }

  // Auto-scroll to bottom when new events arrive
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

  // Mark current tab as seen when the selected filter changes
  LaunchedEffect(selectedFilter) {
    lastSeenCounts[selectedFilter] = categoryCounts[selectedFilter] ?: 0
    onFilterChanged?.invoke(selectedFilter.timelineCategoryKey)
  }

  // Sync: when timeline selection changes, scroll to nearest event
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

  // Sync: when telemetry scrolls, update timeline visible window center
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

  Column(modifier = modifier.fillMaxSize()) {
    // Search bar + severity toggle row
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      SearchBar(
          query = searchQuery,
          onQueryChange = { searchQuery = it },
          placeholder = "Filter events...",
          showRegexToggle = true,
          isRegexEnabled = isRegexEnabled,
          onRegexToggle = { isRegexEnabled = !isRegexEnabled },
          modifier = Modifier.weight(1f),
      )
      // Severity toggle chips
      EventSeverity.entries.forEach { sev ->
        val isEnabled = sev in enabledSeverities
        Box(
            modifier =
                Modifier.background(
                        if (isEnabled) Color(sev.color).copy(alpha = 0.15f) else Color.Transparent,
                        RoundedCornerShape(4.dp),
                    )
                    .clickable {
                      enabledSeverities =
                          if (isEnabled) enabledSeverities - sev else enabledSeverities + sev
                    }
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
        ) {
          Icon(
              sev.icon,
              contentDescription = sev.label,
              modifier = Modifier.size(13.dp),
              tint = Color(sev.color),
          )
        }
      }

      // Spacer between severity chips and action buttons
      Spacer(Modifier.width(8.dp))

      // Action buttons (like Logcat toolbar)
      val coroutineScope = rememberCoroutineScope()
      val buttonModifier =
          Modifier.background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = 6.dp, vertical = 4.dp)

      // Clear all events
      Box(
          modifier =
              Modifier.clickable {
                    events.clear()
                    onEventSelected(null)
                    categoryCounts.clear()
                    lastSeenCounts.clear()
                  }
                  .then(buttonModifier),
      ) {
        Icon(
            AppIcons.Delete,
            contentDescription = "Clear",
            modifier = Modifier.size(14.dp),
            tint = colors.text.normal,
        )
      }

      // Pause / Resume
      Box(
          modifier =
              Modifier.clickable {
                    isPaused = !isPaused
                    if (!isPaused) {
                      autoScrollEnabled = true
                      coroutineScope.launch {
                        val lastVisibleRow =
                            if (selectedFilter == CategoryFilter.Network) {
                              filteredEvents.lastIndex
                            } else {
                              renderedRows.lastIndex
                            }
                        if (lastVisibleRow >= 0) {
                          listState.animateScrollToItem(lastVisibleRow)
                        }
                      }
                    }
                  }
                  .then(buttonModifier)
                  .then(
                      if (isPaused)
                          Modifier.background(
                              Color(0xFFFFA94D).copy(alpha = 0.15f),
                              RoundedCornerShape(4.dp),
                          )
                      else Modifier
                  ),
      ) {
        Icon(
            if (isPaused) AppIcons.Play else AppIcons.Pause,
            contentDescription = if (isPaused) "Resume" else "Pause",
            modifier = Modifier.size(14.dp),
            tint = colors.text.normal,
        )
      }

      // Restart (clear + unpause + scroll to bottom)
      Box(
          modifier =
              Modifier.clickable {
                    events.clear()
                    onEventSelected(null)
                    isPaused = false
                    autoScrollEnabled = true
                    categoryCounts.clear()
                    lastSeenCounts.clear()
                  }
                  .then(buttonModifier),
      ) {
        Icon(
            AppIcons.Refresh,
            contentDescription = "Restart",
            modifier = Modifier.size(14.dp),
            tint = colors.text.normal,
        )
      }

      // Scroll to latest (bottom) + re-enable auto-scroll
      Box(
          modifier =
              Modifier.clickable {
                    autoScrollEnabled = true
                    val lastVisibleRow =
                        if (selectedFilter == CategoryFilter.Network) {
                          filteredEvents.lastIndex
                        } else {
                          renderedRows.lastIndex
                        }
                    if (lastVisibleRow >= 0) {
                      coroutineScope.launch { listState.animateScrollToItem(lastVisibleRow) }
                    }
                  }
                  .then(buttonModifier)
                  .then(
                      if (autoScrollEnabled)
                          Modifier.background(
                              Color(0xFF74C0FC).copy(alpha = 0.15f),
                              RoundedCornerShape(4.dp),
                          )
                      else Modifier
                  ),
      ) {
        Icon(
            AppIcons.ScrollDown,
            contentDescription = "Scroll to bottom",
            modifier = Modifier.size(14.dp),
            tint = colors.text.normal,
        )
      }

      // Bookmarks toggle
      Box(
          modifier =
              Modifier.clickable { showBookmarksOnly = !showBookmarksOnly }
                  .then(buttonModifier)
                  .then(
                      if (showBookmarksOnly)
                          Modifier.background(
                              Color(0xFFFFD43B).copy(alpha = 0.15f),
                              RoundedCornerShape(4.dp),
                          )
                      else Modifier
                  ),
      ) {
        Text(
            if (showBookmarksOnly) "\u2605" else "\u2606", // ★ filled / ☆ outline
            fontSize = 13.sp,
        )
      }

      Spacer(Modifier.width(4.dp))

      // Buffer fill indicator + configurable max events
      Box {
        Box(
            modifier =
                Modifier.background(
                        colors.text.normal.copy(alpha = 0.05f),
                        RoundedCornerShape(4.dp),
                    )
                    .clickable { showMaxEventsDropdown = !showMaxEventsDropdown }
                    .pointerHoverIcon(PointerIcon.Hand)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
        ) {
          Text(
              "${events.size}/$maxEvents",
              fontSize = 10.sp,
              fontFamily = FontFamily.Monospace,
              color = colors.text.normal.copy(alpha = 0.6f),
          )
        }
        if (showMaxEventsDropdown) {
          // Dropdown overlay
          Column(
              modifier =
                  Modifier.padding(top = 28.dp)
                      .background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
                      .padding(2.dp),
          ) {
            MAX_EVENTS_OPTIONS.forEach { option ->
              val isCurrentOption = option == maxEvents
              Box(
                  modifier =
                      Modifier.background(
                              if (isCurrentOption) colors.text.normal.copy(alpha = 0.12f)
                              else Color.Transparent,
                              RoundedCornerShape(3.dp),
                          )
                          .clickable {
                            maxEvents = option
                            showMaxEventsDropdown = false
                            trimEvents(events, option, categoryCounts)
                          }
                          .pointerHoverIcon(PointerIcon.Hand)
                          .padding(horizontal = 8.dp, vertical = 4.dp),
              ) {
                Text(
                    "$option",
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    color =
                        if (isCurrentOption) colors.text.normal
                        else colors.text.normal.copy(alpha = 0.6f),
                )
              }
            }
          }
        }
      }
    }

    // Responsive category filter tabs
    BoxWithConstraints(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
      val tabCount = CategoryFilter.entries.size
      val tabsWithText =
          when {
            maxWidth >= 750.dp -> tabCount
            maxWidth >= 600.dp -> tabCount - 3
            maxWidth >= 450.dp -> tabCount - 6
            maxWidth >= 350.dp -> 3
            else -> 0
          }

      Row(
          modifier = Modifier.horizontalScroll(rememberScrollState()),
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
      ) {
        CategoryFilter.entries.forEachIndexed { index, filter ->
          val isSelected = filter == selectedFilter
          val count = categoryCounts[filter] ?: 0
          val showText = index < tabsWithText
          // Show dot when there are unseen events for this tab
          val lastSeen = lastSeenCounts[filter] ?: 0
          val hasUnseen = !isSelected && filter != CategoryFilter.All && count > lastSeen
          Box(
              modifier =
                  Modifier.background(
                          if (isSelected) colors.text.normal.copy(alpha = 0.12f)
                          else Color.Transparent,
                          RoundedCornerShape(6.dp),
                      )
                      .clickable {
                        selectedFilter = filter
                        lastSeenCounts[filter] = categoryCounts[filter] ?: 0
                      }
                      .pointerHoverIcon(PointerIcon.Hand)
                      .padding(horizontal = if (showText) 8.dp else 6.dp, vertical = 4.dp),
          ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
              Icon(
                  filter.icon,
                  contentDescription = filter.label,
                  modifier = Modifier.size(13.dp),
                  tint =
                      if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
              )
              if (showText) {
                Text(
                    filter.label,
                    fontSize = 11.sp,
                    color =
                        if (isSelected) colors.text.normal
                        else colors.text.normal.copy(alpha = 0.6f),
                )
                if (count > 0) {
                  Text(
                      "$count",
                      fontSize = 9.sp,
                      color = colors.text.normal.copy(alpha = 0.4f),
                  )
                }
              }
              if (hasUnseen) {
                Box(
                    modifier =
                        Modifier.width(6.dp)
                            .height(6.dp)
                            .background(Color(0xFFFF6B6B), RoundedCornerShape(3.dp)),
                )
              }
            }
          }
        }
      }
    }

    // Connection status bar (when disconnected)
    val state = connectionState
    if (state != null && state !is ConnectionState.Connected) {
      val statusText =
          when (state) {
            is ConnectionState.Connecting -> "Connecting..."
            is ConnectionState.Reconnecting -> "Reconnecting (attempt ${state.attempt})..."
            is ConnectionState.Disconnected -> "Disconnected${state.reason?.let { ": $it" } ?: ""}"
            is ConnectionState.Error -> "Error: ${state.message}"
            is ConnectionState.Connected -> ""
          }
      Box(
          modifier =
              Modifier.fillMaxWidth()
                  .background(Color(0xFF5C4033).copy(alpha = 0.3f))
                  .padding(horizontal = 8.dp, vertical = 2.dp),
      ) {
        Text(
            statusText,
            fontSize = 10.sp,
            color = Color(0xFFE0A040),
        )
      }
    }

    // Event list + detail panel
    Row(modifier = Modifier.fillMaxSize()) {
      // Event list (takes remaining space)
      Box(modifier = Modifier.weight(1f)) {
        if (filteredEvents.isEmpty()) {
          Box(
              modifier = Modifier.fillMaxSize(),
              contentAlignment = Alignment.Center,
          ) {
            Text(
                if (dataSourceMode == DataSourceMode.Real) "No telemetry events yet"
                else "No events",
                fontSize = 12.sp,
                color = colors.text.normal.copy(alpha = 0.4f),
            )
          }
        } else if (selectedFilter == CategoryFilter.Network) {
          NetworkTable(
              filteredEvents.filterIsInstance<TelemetryDisplayEvent.Network>(),
              listState,
              timeFormat,
              colors.text.normal,
              selectedEvent = selectedEvent,
              onEventSelected = { onEventSelected(if (selectedEvent == it) null else it) },
          )
        } else {
          LazyColumn(
              state = listState,
              modifier = Modifier.fillMaxSize(),
          ) {
            fun emitEventRow(
                event: TelemetryDisplayEvent,
                keyPrefix: String,
                indented: Boolean = false,
            ) {
              item(key = "${keyPrefix}_${event.timestamp}_${System.identityHashCode(event)}") {
                EventRowWithBookmark(
                    event = event,
                    timeFormat = timeFormat,
                    textColor = colors.text.normal,
                    isSelected = event == selectedEvent,
                    isBookmarked = event in bookmarkedEvents,
                    onToggleBookmark = {
                      if (event in bookmarkedEvents) bookmarkedEvents.remove(event)
                      else bookmarkedEvents.add(event)
                    },
                    onClick = { onEventSelected(if (selectedEvent == event) null else event) },
                    indented = indented,
                )
              }
            }

            groupedItems.forEachIndexed { index, listItem: EventListItem ->
              when (listItem) {
                is EventListItem.Single -> {
                  emitEventRow(listItem.event, "single")
                }
                is EventListItem.Group -> {
                  val groupId = listItem.categoryKey
                  item(key = "group_header_${groupId}_$index") {
                    GroupHeader(
                        categoryKey = listItem.categoryKey,
                        count = listItem.events.size,
                        isExpanded = listItem.isExpanded,
                        textColor = colors.text.normal,
                        onClick = {
                          if (groupId in expandedGroups) expandedGroups.remove(groupId)
                          else expandedGroups.add(groupId)
                        },
                    )
                  }
                  if (listItem.isExpanded) {
                    listItem.events.forEach { event ->
                      emitEventRow(event, "grouped", indented = true)
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Detail panel moved to the right inspector pane (RightInspectorPanel)
    }
  }

  // Auto-scroll to top when new events arrive and user is near top
  LaunchedEffect(filteredEvents.size) {
    if (listState.firstVisibleItemIndex <= 2) {
      listState.animateScrollToItem(0)
    }
  }
}

/**
 * Data class used to trigger snapshotFlow recomputations when filter inputs change. [eventVersion]
 * captures both the size and a rolling change token so that add-then-trim cycles (where the buffer
 * stays the same size) still re-trigger filtering.
 */
private data class FilterInputs(
    val eventCount: Int,
    val lastEventTimestamp: Long?,
    val filter: CategoryFilter,
    val query: String,
    val severities: Set<EventSeverity>,
    val regex: Boolean,
    val showBookmarksOnly: Boolean,
    val bookmarkedCount: Int,
)

/**
 * Maps a [TelemetryDisplayEvent] to its [CategoryFilter] (excluding [CategoryFilter.All]). Returns
 * null for event types that have no dedicated tab.
 */
private fun categoryOf(event: TelemetryDisplayEvent): CategoryFilter? =
    when (event) {
      is TelemetryDisplayEvent.Network -> CategoryFilter.Network
      is TelemetryDisplayEvent.Navigation -> CategoryFilter.Navigation
      is TelemetryDisplayEvent.Log -> CategoryFilter.Logs
      is TelemetryDisplayEvent.Os -> CategoryFilter.Os
      is TelemetryDisplayEvent.Failure -> CategoryFilter.Failures
      is TelemetryDisplayEvent.Storage -> CategoryFilter.Storage
      is TelemetryDisplayEvent.Layout -> CategoryFilter.Layout
      is TelemetryDisplayEvent.Performance -> CategoryFilter.Performance
      is TelemetryDisplayEvent.ToolCall -> CategoryFilter.ToolCalls
      else -> null
    }

/** Increment category counts for a newly added event. */
private fun incrementCount(
    counts: MutableMap<CategoryFilter, Int>,
    event: TelemetryDisplayEvent,
) {
  counts[CategoryFilter.All] = (counts[CategoryFilter.All] ?: 0) + 1
  val cat = categoryOf(event)
  if (cat != null) {
    counts[cat] = (counts[cat] ?: 0) + 1
  }
}

/** Remove oldest events until [events] fits within [limit], decrementing [counts]. */
private fun trimEvents(
    events: MutableList<TelemetryDisplayEvent>,
    limit: Int,
    counts: MutableMap<CategoryFilter, Int>,
) {
  while (events.size > limit) {
    val removed = events.removeAt(0)
    counts[CategoryFilter.All] = ((counts[CategoryFilter.All] ?: 1) - 1).coerceAtLeast(0)
    val cat = categoryOf(removed)
    if (cat != null) {
      counts[cat] = ((counts[cat] ?: 1) - 1).coerceAtLeast(0)
    }
  }
}

/** Builds the filtered event list given the current filter/search parameters. */
private fun buildFilteredList(
    events: List<TelemetryDisplayEvent>,
    selectedFilter: CategoryFilter,
    query: String,
    enabledSeverities: Set<EventSeverity>,
    useRegex: Boolean,
): List<TelemetryDisplayEvent> {
  var result: List<TelemetryDisplayEvent> = events

  if (selectedFilter != CategoryFilter.All) {
    result = result.filter { categoryOf(it) == selectedFilter }
  }

  if (enabledSeverities.size < EventSeverity.entries.size) {
    result = result.filter { it.eventSeverity in enabledSeverities }
  }

  if (query.isNotEmpty()) {
    result = result.filter { it.matchesSearch(query, useRegex) }
  }

  return result
}

@Composable
private fun GroupHeader(
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

@Composable
private fun EventRowWithBookmark(
    event: TelemetryDisplayEvent,
    timeFormat: SimpleDateFormat,
    textColor: Color,
    isSelected: Boolean,
    isBookmarked: Boolean,
    onToggleBookmark: () -> Unit,
    onClick: () -> Unit,
    indented: Boolean = false,
) {
  Row(
      modifier =
          Modifier.fillMaxWidth()
              .then(
                  if (isSelected) Modifier.background(textColor.copy(alpha = 0.08f)) else Modifier
              )
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
        imageVector =
            when (event) {
              is TelemetryDisplayEvent.Network -> AppIcons.Network
              is TelemetryDisplayEvent.Navigation -> AppIcons.Navigation
              is TelemetryDisplayEvent.Log -> AppIcons.Logs
              is TelemetryDisplayEvent.Os -> AppIcons.Os
              is TelemetryDisplayEvent.Failure ->
                  when (event.type) {
                    "crash" -> AppIcons.Crash
                    "anr" -> AppIcons.Anr
                    else -> AppIcons.NonFatal
                  }
              is TelemetryDisplayEvent.Storage -> AppIcons.StorageCategory
              is TelemetryDisplayEvent.Layout -> AppIcons.Layout
              is TelemetryDisplayEvent.Performance -> AppIcons.Performance
              is TelemetryDisplayEvent.Memory -> AppIcons.Memory
              is TelemetryDisplayEvent.ToolCall -> AppIcons.ToolCalls
              is TelemetryDisplayEvent.Accessibility -> AppIcons.Accessibility
            },
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

private fun networkStatusColor(statusCode: Int, error: String?, textColor: Color): Color =
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

private data class NetworkColumn(val label: String, val width: Int)

private val networkColumns =
    listOf(
        NetworkColumn("Time", 90),
        NetworkColumn("Method", 55),
        NetworkColumn("Status", 50),
        NetworkColumn("Host", 140),
        NetworkColumn("Path", 160),
        NetworkColumn("Duration", 70),
        NetworkColumn("Error", 180),
    )

@Composable
private fun NetworkTable(
    events: List<TelemetryDisplayEvent.Network>,
    listState: androidx.compose.foundation.lazy.LazyListState,
    timeFormat: SimpleDateFormat,
    textColor: Color,
    selectedEvent: TelemetryDisplayEvent? = null,
    onEventSelected: (TelemetryDisplayEvent.Network) -> Unit = {},
) {
  val scrollState = rememberScrollState()

  Column(modifier = Modifier.fillMaxSize()) {
    // Header row
    Row(
        modifier =
            Modifier.fillMaxWidth()
                .background(textColor.copy(alpha = 0.05f))
                .horizontalScroll(scrollState)
                .padding(vertical = 6.dp),
    ) {
      networkColumns.forEach { col ->
        Box(modifier = Modifier.width(col.width.dp).padding(horizontal = 6.dp)) {
          Text(
              col.label,
              fontSize = 10.sp,
              fontWeight = FontWeight.SemiBold,
              fontFamily = FontFamily.Monospace,
              color = textColor,
              maxLines = 1,
          )
        }
      }
    }

    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(textColor.copy(alpha = 0.1f)))

    // Data rows
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
      items(events, key = { "${it.timestamp}_${System.identityHashCode(it)}" }) { event ->
        val color = networkStatusColor(event.statusCode, event.error, textColor)
        val formattedTime = remember(event.timestamp) { timeFormat.format(Date(event.timestamp)) }
        val isSelected = event == selectedEvent

        Row(
            modifier =
                Modifier.fillMaxWidth()
                    .then(
                        if (isSelected) Modifier.background(textColor.copy(alpha = 0.08f))
                        else Modifier
                    )
                    .clickable { onEventSelected(event) }
                    .pointerHoverIcon(PointerIcon.Hand)
                    .horizontalScroll(scrollState)
                    .padding(vertical = 3.dp),
        ) {
          // Time
          Box(modifier = Modifier.width(networkColumns[0].width.dp).padding(horizontal = 6.dp)) {
            Text(
                formattedTime,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = textColor.copy(alpha = 0.5f),
                maxLines = 1,
            )
          }
          // Method
          Box(modifier = Modifier.width(networkColumns[1].width.dp).padding(horizontal = 6.dp)) {
            Text(
                event.method,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = color,
                maxLines = 1,
            )
          }
          // Status
          Box(modifier = Modifier.width(networkColumns[2].width.dp).padding(horizontal = 6.dp)) {
            Text(
                "${event.statusCode}",
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = color,
                maxLines = 1,
            )
          }
          // Host
          Box(modifier = Modifier.width(networkColumns[3].width.dp).padding(horizontal = 6.dp)) {
            Text(
                event.host ?: "",
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = textColor.copy(alpha = 0.85f),
                maxLines = 1,
            )
          }
          // Path
          Box(modifier = Modifier.width(networkColumns[4].width.dp).padding(horizontal = 6.dp)) {
            Text(
                event.path ?: event.url,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = textColor.copy(alpha = 0.85f),
                maxLines = 1,
            )
          }
          // Duration
          Box(modifier = Modifier.width(networkColumns[5].width.dp).padding(horizontal = 6.dp)) {
            Text(
                "${event.durationMs}ms",
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = textColor.copy(alpha = 0.7f),
                maxLines = 1,
            )
          }
          // Error
          Box(modifier = Modifier.width(networkColumns[6].width.dp).padding(horizontal = 6.dp)) {
            Text(
                event.error ?: "",
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                color = Color(0xFFE06060),
                maxLines = 1,
            )
          }
        }
      }
    }
  }
}

@Composable
private fun LogSummary(event: TelemetryDisplayEvent.Log, textColor: Color) {
  val levelLetter =
      when (event.level) {
        2 -> "V"
        3 -> "D"
        4 -> "I"
        5 -> "W"
        6 -> "E"
        7 -> "A"
        else -> "?"
      }
  val color =
      when (event.level) {
        2 -> textColor.copy(alpha = 0.4f) // Verbose
        3 -> textColor.copy(alpha = 0.6f) // Debug
        4 -> textColor.copy(alpha = 0.85f) // Info
        5 -> Color(0xFFE0C040) // Warning - yellow
        6 -> Color(0xFFE06060) // Error - red
        7 -> Color(0xFFFF4040) // Assert - bright red
        else -> textColor.copy(alpha = 0.6f)
      }

  Text(
      "$levelLetter [${event.tag}] ${event.message}",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = color,
      maxLines = 1,
  )
}

@Composable
private fun NavigationSummary(event: TelemetryDisplayEvent.Navigation, textColor: Color) {
  val argsText = event.arguments?.entries?.joinToString(", ") { "${it.key}=${it.value}" }
  val suffix = if (argsText != null) " ($argsText)" else ""

  Text(
      "${event.destination}$suffix",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = Color(0xFF74C0FC), // light blue
      maxLines = 1,
  )
}

@Composable
private fun OsSummary(event: TelemetryDisplayEvent.Os, textColor: Color) {
  val d = event.details
  val detailsText =
      if (d != null && d.isNotEmpty()) {
        " ${d.entries.joinToString(", ") { "${it.key}:${it.value}" }}"
      } else {
        ""
      }
  val color =
      when (event.kind) {
        "foreground" -> Color(0xFF51CF66) // green
        "background" -> Color(0xFFFFA94D) // orange
        "connectivity_change" -> {
          val connected = event.details?.get("connected")
          if (connected == "true") Color(0xFF51CF66) else Color(0xFFFF6B6B)
        }
        "screen_off" -> textColor.copy(alpha = 0.4f)
        else -> textColor.copy(alpha = 0.85f)
      }

  Text(
      "[${event.category}] ${event.kind}$detailsText",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = color,
      maxLines = 1,
  )
}

@Composable
private fun FailureSummary(event: TelemetryDisplayEvent.Failure, textColor: Color) {
  val color =
      when (event.severity) {
        "critical" -> Color(0xFFFF4040) // bright red
        "high" -> Color(0xFFFF6B6B) // red
        "medium" -> Color(0xFFE0C040) // yellow
        "low" -> textColor.copy(alpha = 0.7f)
        else -> textColor.copy(alpha = 0.85f)
      }
  val typeLabel =
      when (event.type) {
        "crash" -> "CRASH"
        "anr" -> "ANR"
        "nonfatal" -> "NON-FATAL"
        else -> event.type.uppercase()
      }
  val screenSuffix = event.screen?.let { " @ $it" } ?: ""

  Text(
      "[$typeLabel] ${event.title}$screenSuffix",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = color,
      maxLines = 1,
  )
}

@Composable
private fun StorageSummary(event: TelemetryDisplayEvent.Storage, textColor: Color) {
  val changeLabel = event.changeType.uppercase()
  val keyPart = event.key?.let { ":$it" } ?: ""
  val valuePart = event.value?.let { " = $it" } ?: ""

  Text(
      "[$changeLabel] ${event.fileName}$keyPart$valuePart",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.85f),
      maxLines = 1,
  )
}

@Composable
private fun LayoutSummary(event: TelemetryDisplayEvent.Layout, textColor: Color) {
  val text =
      when (event.subType) {
        "excessive_recomposition" -> {
          val name = event.composableName ?: "unknown"
          val count = event.recompositionCount?.let { "${it}/s" } ?: ""
          val cause = event.likelyCause?.let { " ($it)" } ?: ""
          "RECOMP $name $count$cause"
        }
        "recomposition" -> {
          val name = event.composableName ?: "unknown"
          val count = event.recompositionCount?.let { "${it}/s" } ?: ""
          "recomp $name $count"
        }
        "hierarchy_change" -> "Hierarchy update"
        else -> event.subType
      }
  val color =
      when (event.subType) {
        "excessive_recomposition" -> Color(0xFFFFA94D) // orange
        "recomposition" -> Color(0xFF74C0FC) // light blue
        else -> textColor.copy(alpha = 0.7f)
      }

  Text(
      text,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = color,
      maxLines = 1,
  )
}

@Composable
private fun PerformanceSummary(event: TelemetryDisplayEvent.Performance, textColor: Color) {
  val changed = event.changedMetrics.joinToString(", ")
  val metrics = buildString {
    event.fps?.let { append("${it.toInt()}fps ") }
    event.frameTimeMs?.let { append("${it.toInt()}ms ") }
    event.jankFrames?.let { if (it > 0) append("${it}jank ") }
    event.memoryUsageMb?.let { append("${it.toInt()}MB ") }
  }
      .trim()
  val text = "[${event.health.uppercase()}] $metrics ($changed)"
  val color =
      when (event.health) {
        "critical" -> Color(0xFFFF4040)
        "warning" -> Color(0xFFFFA94D)
        else -> Color(0xFF51CF66)
      }

  Text(
      text,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = color,
      maxLines = 1,
  )
}

@Composable
private fun MemorySummary(event: TelemetryDisplayEvent.Memory, textColor: Color) {
  val status = if (event.passed) "PASS" else "FAIL"
  val growth = event.javaHeapGrowthMb?.let { "+${"%.1f".format(it)}MB" } ?: ""
  val text = "[$status] ${event.packageName.substringAfterLast('.')} $growth"
  val color = if (event.passed) Color(0xFF51CF66) else Color(0xFFFF6B6B)
  Text(text, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
}

@Composable
private fun ToolCallSummary(event: TelemetryDisplayEvent.ToolCall, textColor: Color) {
  val status = if (event.success) "${event.durationMs}ms" else "FAILED"
  val err = event.error
  val errorSuffix = if (!event.success && err != null) " (${err.take(30)})" else ""
  val color =
      when {
        !event.success -> Color(0xFFFF6B6B)
        event.durationMs > 5000 -> Color(0xFFFFA94D)
        else -> Color(0xFF51CF66)
      }
  Text(
      "${event.toolName} $status$errorSuffix",
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = color,
      maxLines = 1,
  )
}

@Composable
private fun A11ySummary(event: TelemetryDisplayEvent.Accessibility, textColor: Color) {
  val color = if (event.newViolations > 0) Color(0xFFFFA94D) else Color(0xFF51CF66)
  val text = "${event.newViolations} violations (${event.packageName.substringAfterLast('.')})"
  Text(text, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
}

/** Generates sample telemetry events for Fake/development mode. */
private fun generateFakeEvents(): List<TelemetryDisplayEvent> {
  val now = System.currentTimeMillis()
  return listOf(
      TelemetryDisplayEvent.Network(
          timestamp = now - 500,
          method = "GET",
          statusCode = 200,
          url = "https://api.example.com/users",
          durationMs = 42,
          host = "api.example.com",
          path = "/users",
          error = null,
          requestHeaders =
              mapOf("Accept" to "application/json", "Authorization" to "Bearer tok_xxx"),
          responseHeaders =
              mapOf("Content-Type" to "application/json", "X-Request-Id" to "abc-123"),
          requestBody = null,
          responseBody = """[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]""",
          contentType = "application/json",
      ),
      TelemetryDisplayEvent.Network(
          timestamp = now - 1200,
          method = "POST",
          statusCode = 500,
          url = "https://api.example.com/upload",
          durationMs = 1530,
          host = "api.example.com",
          path = "/upload",
          error = "Internal Server Error",
          requestHeaders = mapOf("Content-Type" to "application/json"),
          responseHeaders = null,
          requestBody = """{"file":"data.csv","size":1024}""",
          responseBody = null,
          contentType = null,
      ),
      TelemetryDisplayEvent.Log(
          timestamp = now - 2000,
          level = 4,
          tag = "MainActivity",
          message = "Activity resumed",
      ),
      TelemetryDisplayEvent.Log(
          timestamp = now - 2500,
          level = 5,
          tag = "NetworkManager",
          message = "Slow response detected: 1530ms",
      ),
      TelemetryDisplayEvent.Log(
          timestamp = now - 3000,
          level = 6,
          tag = "CrashReporter",
          message = "Unhandled exception in coroutine",
      ),
      TelemetryDisplayEvent.Os(
          timestamp = now - 4000,
          category = "lifecycle",
          kind = "foreground",
          details = null,
      ),
      TelemetryDisplayEvent.Os(
          timestamp = now - 5500,
          category = "broadcast",
          kind = "LOCALE_CHANGED",
          details = mapOf("locale" to "en_US"),
      ),
      TelemetryDisplayEvent.Navigation(
          timestamp = now - 5800,
          destination = "HomeScreen",
          source = "sdk",
          arguments = mapOf("tab" to "discover"),
          metadata = null,
          triggeringInteraction = "tap on 'Home'",
          screenshotUri = null,
      ),
      TelemetryDisplayEvent.Log(
          timestamp = now - 6000,
          level = 4,
          tag = "CustomEvent",
          message = "button_click {screen:home, button:refresh}",
      ),
      TelemetryDisplayEvent.Log(
          timestamp = now - 7000,
          level = 4,
          tag = "CustomEvent",
          message = "purchase_completed {item:premium, price:9.99}",
      ),
      TelemetryDisplayEvent.Network(
          timestamp = now - 8000,
          method = "GET",
          statusCode = 404,
          url = "https://api.example.com/missing",
          durationMs = 15,
          host = "api.example.com",
          path = "/missing",
          error = null,
          requestHeaders = null,
          responseHeaders = null,
          requestBody = null,
          responseBody = null,
          contentType = null,
      ),
      TelemetryDisplayEvent.Failure(
          timestamp = now - 9000,
          type = "crash",
          occurrenceId = "occ-001",
          severity = "critical",
          title = "NullPointerException at UserRepository.kt:42",
          exceptionType = "java.lang.NullPointerException",
          screen = "ProfileScreen",
          stackTrace =
              listOf(
                  StackTraceFrame(
                      "com.example.app.UserRepository",
                      "getUser",
                      "UserRepository.kt",
                      42,
                      true,
                  ),
                  StackTraceFrame(
                      "com.example.app.ProfileViewModel",
                      "loadProfile",
                      "ProfileViewModel.kt",
                      28,
                      true,
                  ),
                  StackTraceFrame("androidx.lifecycle.ViewModel", "init", null, null, false),
              ),
      ),
      TelemetryDisplayEvent.Failure(
          timestamp = now - 10000,
          type = "anr",
          occurrenceId = "occ-002",
          severity = "high",
          title = "Main thread blocked in NetworkManager.fetch",
          exceptionType = null,
          screen = "HomeScreen",
          stackTrace = null,
      ),
      TelemetryDisplayEvent.Failure(
          timestamp = now - 11000,
          type = "nonfatal",
          occurrenceId = "occ-003",
          severity = "medium",
          title = "IOException at CacheManager.kt:88",
          exceptionType = "java.io.IOException",
          screen = "SettingsScreen",
          stackTrace =
              listOf(
                  StackTraceFrame(
                      "com.example.app.CacheManager",
                      "writeCache",
                      "CacheManager.kt",
                      88,
                      true,
                  ),
                  StackTraceFrame("java.io.FileOutputStream", "write", null, null, false),
              ),
      ),
      TelemetryDisplayEvent.Storage(
          timestamp = now - 12000,
          fileName = "user_prefs.xml",
          key = "dark_mode",
          value = "true",
          valueType = "BOOLEAN",
          changeType = "modify",
          previousValue = "false",
      ),
      TelemetryDisplayEvent.Storage(
          timestamp = now - 13000,
          fileName = "session.xml",
          key = "auth_token",
          value = null,
          valueType = null,
          changeType = "remove",
          previousValue = "eyJhbGciOiJIUzI1NiJ9...",
      ),
      TelemetryDisplayEvent.Layout(
          timestamp = now - 14000,
          subType = "excessive_recomposition",
          composableName = "AnimatedCounter",
          recompositionCount = 15,
          durationMs = 8,
          likelyCause = "unstable_lambda",
          screenName = "HomeScreen",
          detailsJson = null,
      ),
      TelemetryDisplayEvent.Layout(
          timestamp = now - 15000,
          subType = "hierarchy_change",
          composableName = null,
          recompositionCount = null,
          durationMs = null,
          likelyCause = null,
          screenName = "SettingsScreen",
          detailsJson =
              """{"screenName":"SettingsScreen","windowCount":3,"foregroundActivity":"com.example.app.SettingsActivity"}""",
      ),
  )
}
