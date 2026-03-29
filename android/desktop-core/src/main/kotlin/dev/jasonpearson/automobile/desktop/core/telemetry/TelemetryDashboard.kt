package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import kotlinx.coroutines.launch
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.vector.ImageVector
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons
import kotlinx.coroutines.delay
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import androidx.compose.material3.Text
import dev.jasonpearson.automobile.desktop.core.platform.SwingFileSaver
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.swing.JFileChooser
import javax.swing.filechooser.FileNameExtensionFilter

private const val GROUP_THRESHOLD = 3

/**
 * Returns a category key used to group consecutive same-type events.
 */
private fun TelemetryDisplayEvent.categoryKey(): String = when (this) {
    is TelemetryDisplayEvent.Network -> "Network"
    is TelemetryDisplayEvent.Navigation -> "Navigation"
    is TelemetryDisplayEvent.Log -> "Log"
    is TelemetryDisplayEvent.Os -> "OS"
    is TelemetryDisplayEvent.Custom -> "Custom"
    is TelemetryDisplayEvent.Failure -> "Failure"
    is TelemetryDisplayEvent.Storage -> "Storage"
    is TelemetryDisplayEvent.Layout -> "Layout"
    is TelemetryDisplayEvent.Performance -> "Performance"
    is TelemetryDisplayEvent.Memory -> "Memory"
    is TelemetryDisplayEvent.ToolCall -> "ToolCall"
    is TelemetryDisplayEvent.Accessibility -> "Accessibility"
}

/**
 * A row in the event list: either a single event or a collapsible group of
 * 3+ consecutive same-type events.
 */
private sealed class EventListItem {
    data class Single(val event: TelemetryDisplayEvent) : EventListItem()
    data class Group(
        val categoryKey: String,
        val events: List<TelemetryDisplayEvent>,
        val isExpanded: Boolean,
    ) : EventListItem()
}

/**
 * Processes a flat event list into [EventListItem]s, collapsing runs of 3+
 * consecutive same-category events into groups.
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
            val groupId = "${key}_${events[runStart].timestamp}"
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

private const val MAX_EVENTS = 1000

private enum class CategoryFilter(val label: String, val icon: ImageVector) {
    All("All", AppIcons.All),
    Network("Network", AppIcons.Network),
    Navigation("Nav", AppIcons.Navigation),
    Logs("Logs", AppIcons.Logs),
    Os("OS", AppIcons.Os),
    Custom("Custom", AppIcons.Custom),
    Failures("Failures", AppIcons.Failures),
    Storage("Storage", AppIcons.StorageCategory),
    Layout("Layout", AppIcons.Layout),
    Performance("Perf", AppIcons.Performance),
    ToolCalls("Tools", AppIcons.ToolCalls),
}

/**
 * Telemetry dashboard showing a real-time scrollable event list
 * with category filtering (Network, Logs, OS, Custom).
 */
@Composable
fun TelemetryDashboard(
    telemetryPushClient: TelemetryPushClient?,
    dataSourceMode: DataSourceMode,
    onOpenSource: ((String, Int, String) -> Unit)? = null,
    screenshotLoader: dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader? = null,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val events = remember { mutableStateListOf<TelemetryDisplayEvent>() }
    var selectedFilter by remember { mutableStateOf(CategoryFilter.All) }
    var connectionState by remember { mutableStateOf<TelemetryConnectionState?>(null) }
    var selectedEvent by remember { mutableStateOf<TelemetryDisplayEvent?>(null) }
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

    // Export/session menu state
    var showExportMenu by remember { mutableStateOf(false) }

    // Time range brush state
    var timeRangeSelection by remember { mutableStateOf<LongRange?>(null) }

    // Network waterfall toggle (only when Network filter is active)
    var showWaterfall by remember { mutableStateOf(false) }

    // Network diff: hold two events for comparison
    var diffLeft by remember { mutableStateOf<TelemetryDisplayEvent.Network?>(null) }
    var diffRight by remember { mutableStateOf<TelemetryDisplayEvent.Network?>(null) }
    var showDiff by remember { mutableStateOf(false) }

    LaunchedEffect(searchQuery) {
        delay(150)
        debouncedQuery = searchQuery
    }

    // Collect telemetry events from the push client (newest at bottom)
    LaunchedEffect(telemetryPushClient, isPaused) {
        val client = telemetryPushClient ?: return@LaunchedEffect
        client.telemetryEvents.collect { event ->
            if (!isPaused) {
                events.add(event)
                // Cap at MAX_EVENTS (remove oldest from front)
                while (events.size > MAX_EVENTS) {
                    events.removeAt(0)
                }
            }
        }
    }

    // Track whether user has scrolled away from the bottom (disables auto-scroll)
    LaunchedEffect(listState.isScrollInProgress) {
        if (listState.isScrollInProgress) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val totalItems = listState.layoutInfo.totalItemsCount
            autoScrollEnabled = totalItems - lastVisible <= 3
        }
    }

    // Collect connection state
    LaunchedEffect(telemetryPushClient) {
        val client = telemetryPushClient ?: return@LaunchedEffect
        client.connectionState.collect { state ->
            connectionState = state
        }
    }

    // Generate fake events in Fake mode
    LaunchedEffect(dataSourceMode) {
        if (dataSourceMode != DataSourceMode.Fake) return@LaunchedEffect
        val fakeEvents = generateFakeEvents()
        events.addAll(fakeEvents)
    }

    // Filtered events — chains category, severity, bookmark, time range, and text search filters.
    // derivedStateOf tracks SnapshotStateList mutations correctly.
    val filteredEvents by remember(selectedFilter, debouncedQuery, enabledSeverities, showBookmarksOnly, timeRangeSelection) {
        derivedStateOf {
            var result: List<TelemetryDisplayEvent> = if (showBookmarksOnly) {
                bookmarkedEvents.toList()
            } else {
                events.toList()
            }

            // Category filter
            if (selectedFilter != CategoryFilter.All) {
                result = result.filter { event ->
                    when (selectedFilter) {
                        CategoryFilter.All -> true
                        CategoryFilter.Network -> event is TelemetryDisplayEvent.Network
                        CategoryFilter.Navigation -> event is TelemetryDisplayEvent.Navigation
                        CategoryFilter.Logs -> event is TelemetryDisplayEvent.Log
                        CategoryFilter.Os -> event is TelemetryDisplayEvent.Os
                        CategoryFilter.Custom -> event is TelemetryDisplayEvent.Custom
                        CategoryFilter.Failures -> event is TelemetryDisplayEvent.Failure
                        CategoryFilter.Storage -> event is TelemetryDisplayEvent.Storage
                        CategoryFilter.Layout -> event is TelemetryDisplayEvent.Layout
                        CategoryFilter.Performance -> event is TelemetryDisplayEvent.Performance
                        CategoryFilter.ToolCalls -> event is TelemetryDisplayEvent.ToolCall
                    }
                }
            }

            // Severity filter
            if (enabledSeverities.size < EventSeverity.entries.size) {
                result = result.filter { it.eventSeverity in enabledSeverities }
            }

            // Time range filter
            val range = timeRangeSelection
            if (range != null) {
                result = result.filter { it.timestamp in range }
            }

            // Text search filter
            if (debouncedQuery.isNotEmpty()) {
                result = result.filter { it.matchesSearch(debouncedQuery) }
            }

            result
        }
    }

    // Grouped event list items for the LazyColumn
    val groupedItems by remember {
        derivedStateOf {
            groupEvents(filteredEvents, expandedGroups.toSet())
        }
    }

    // Auto-scroll to bottom when new events arrive
    LaunchedEffect(filteredEvents.size) {
        if (autoScrollEnabled && !isPaused && filteredEvents.isNotEmpty()) {
            listState.animateScrollToItem(filteredEvents.size - 1)
        }
    }

    // Category counts
    val counts by remember {
        derivedStateOf {
            mapOf(
                CategoryFilter.All to events.size,
                CategoryFilter.Network to events.count { it is TelemetryDisplayEvent.Network },
                CategoryFilter.Navigation to events.count { it is TelemetryDisplayEvent.Navigation },
                CategoryFilter.Logs to events.count { it is TelemetryDisplayEvent.Log },
                CategoryFilter.Os to events.count { it is TelemetryDisplayEvent.Os },
                CategoryFilter.Custom to events.count { it is TelemetryDisplayEvent.Custom },
                CategoryFilter.Failures to events.count { it is TelemetryDisplayEvent.Failure },
                CategoryFilter.Storage to events.count { it is TelemetryDisplayEvent.Storage },
                CategoryFilter.Layout to events.count { it is TelemetryDisplayEvent.Layout },
                CategoryFilter.Performance to events.count { it is TelemetryDisplayEvent.Performance },
                CategoryFilter.ToolCalls to events.count { it is TelemetryDisplayEvent.ToolCall },
            )
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        // Search bar + severity toggle row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            SearchBar(
                query = searchQuery,
                onQueryChange = { searchQuery = it },
                placeholder = "Filter events...",
                modifier = Modifier.weight(1f),
            )
            // Severity toggle chips
            EventSeverity.entries.forEach { sev ->
                val isEnabled = sev in enabledSeverities
                Box(
                    modifier = Modifier
                        .background(
                            if (isEnabled) Color(sev.color).copy(alpha = 0.15f) else Color.Transparent,
                            RoundedCornerShape(4.dp),
                        )
                        .clickable {
                            enabledSeverities = if (isEnabled) enabledSeverities - sev else enabledSeverities + sev
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
            val buttonModifier = Modifier
                .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 6.dp, vertical = 4.dp)

            // Clear all events
            Box(
                modifier = Modifier
                    .clickable { events.clear(); selectedEvent = null }
                    .then(buttonModifier),
            ) {
                Icon(AppIcons.Delete, contentDescription = "Clear", modifier = Modifier.size(14.dp), tint = colors.text.normal)
            }

            // Pause / Resume
            Box(
                modifier = Modifier
                    .clickable {
                        isPaused = !isPaused
                        if (!isPaused) {
                            autoScrollEnabled = true
                            coroutineScope.launch {
                                if (filteredEvents.isNotEmpty()) {
                                    listState.animateScrollToItem(filteredEvents.size - 1)
                                }
                            }
                        }
                    }
                    .then(buttonModifier)
                    .then(if (isPaused) Modifier.background(Color(0xFFFFA94D).copy(alpha = 0.15f), RoundedCornerShape(4.dp)) else Modifier),
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
                modifier = Modifier
                    .clickable {
                        events.clear(); selectedEvent = null; isPaused = false; autoScrollEnabled = true
                    }
                    .then(buttonModifier),
            ) {
                Icon(AppIcons.Refresh, contentDescription = "Restart", modifier = Modifier.size(14.dp), tint = colors.text.normal)
            }

            // Scroll to latest (bottom) + re-enable auto-scroll
            Box(
                modifier = Modifier
                    .clickable {
                        autoScrollEnabled = true
                        if (filteredEvents.isNotEmpty()) {
                            coroutineScope.launch {
                                listState.animateScrollToItem(filteredEvents.size - 1)
                            }
                        }
                    }
                    .then(buttonModifier),
            ) {
                Icon(AppIcons.ScrollDown, contentDescription = "Scroll to bottom", modifier = Modifier.size(14.dp), tint = colors.text.normal)
            }

            // Bookmarks toggle
            Box(
                modifier = Modifier
                    .clickable { showBookmarksOnly = !showBookmarksOnly }
                    .then(buttonModifier)
                    .then(
                        if (showBookmarksOnly) Modifier.background(
                            Color(0xFFFFD43B).copy(alpha = 0.15f),
                            RoundedCornerShape(4.dp),
                        ) else Modifier
                    ),
            ) {
                Text(
                    if (showBookmarksOnly) "\u2605" else "\u2606", // ★ filled / ☆ outline
                    fontSize = 13.sp,
                )
            }

            Spacer(Modifier.width(4.dp))

            // Export / Session menu
            Box {
                Box(
                    modifier = Modifier
                        .clickable { showExportMenu = !showExportMenu }
                        .then(buttonModifier),
                ) {
                    Text("\u2B07", fontSize = 13.sp) // download arrow
                }
                if (showExportMenu) {
                    ExportSessionMenu(
                        events = events.toList(),
                        filteredEvents = filteredEvents,
                        selectedFilter = selectedFilter,
                        onDismiss = { showExportMenu = false },
                        onLoadSession = { loaded ->
                            events.clear()
                            events.addAll(loaded)
                            // Reset transient view state so stale selections don't
                            // bleed across session boundaries.
                            selectedEvent = null
                            timeRangeSelection = null
                            diffLeft = null
                            diffRight = null
                            showDiff = false
                            showExportMenu = false
                        },
                        textColor = colors.text.normal,
                    )
                }
            }

            // Waterfall toggle (only when Network filter is active)
            if (selectedFilter == CategoryFilter.Network) {
                Box(
                    modifier = Modifier
                        .clickable { showWaterfall = !showWaterfall }
                        .then(buttonModifier)
                        .then(
                            if (showWaterfall) Modifier.background(
                                Color(0xFF74C0FC).copy(alpha = 0.15f),
                                RoundedCornerShape(4.dp),
                            ) else Modifier
                        ),
                ) {
                    Text("\u2500", fontSize = 13.sp) // horizontal bar icon for waterfall
                }
            }

            // Diff toggle (only when exactly 2 network events are selected)
            if (selectedFilter == CategoryFilter.Network && diffLeft != null && diffRight != null) {
                Box(
                    modifier = Modifier
                        .clickable { showDiff = !showDiff }
                        .then(buttonModifier)
                        .then(
                            if (showDiff) Modifier.background(
                                Color(0xFF74C0FC).copy(alpha = 0.15f),
                                RoundedCornerShape(4.dp),
                            ) else Modifier
                        ),
                ) {
                    Text("\u2194", fontSize = 13.sp) // left-right arrow for diff
                }
            }
        }

        // Responsive category filter tabs
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            val tabCount = CategoryFilter.entries.size
            val tabsWithText = when {
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
                    val count = counts[filter] ?: 0
                    val showText = index < tabsWithText
                    Box(
                        modifier = Modifier
                            .background(
                                if (isSelected) colors.text.normal.copy(alpha = 0.12f) else Color.Transparent,
                                RoundedCornerShape(6.dp),
                            )
                            .clickable { selectedFilter = filter }
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
                                tint = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
                            )
                            if (showText) {
                                Text(
                                    filter.label,
                                    fontSize = 11.sp,
                                    color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
                                )
                                if (count > 0) {
                                    Text(
                                        "$count",
                                        fontSize = 9.sp,
                                        color = colors.text.normal.copy(alpha = 0.4f),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Connection status bar (when disconnected)
        val state = connectionState
        if (state != null && state !is TelemetryConnectionState.Connected) {
            val statusText = when (state) {
                is TelemetryConnectionState.Connecting -> "Connecting..."
                is TelemetryConnectionState.Reconnecting -> "Reconnecting (attempt ${state.attempt})..."
                is TelemetryConnectionState.Disconnected -> "Disconnected${state.reason?.let { ": $it" } ?: ""}"
                is TelemetryConnectionState.Connected -> ""
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
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

        // Time range brush (event density histogram with drag-to-select)
        if (events.size > 1) {
            TimeRangeBrush(
                events = events.toList(),
                selectedRange = timeRangeSelection,
                onRangeChanged = { timeRangeSelection = it },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            )
        }

        // Network diff view (shown when enabled and two events selected)
        if (showDiff && diffLeft != null && diffRight != null && selectedFilter == CategoryFilter.Network) {
            NetworkDiffView(
                left = diffLeft!!,
                right = diffRight!!,
                modifier = Modifier.fillMaxWidth().height(300.dp),
            )
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
                            if (dataSourceMode == DataSourceMode.Real) "No telemetry events yet" else "No events",
                            fontSize = 12.sp,
                            color = colors.text.normal.copy(alpha = 0.4f),
                        )
                    }
                } else if (selectedFilter == CategoryFilter.Network && showWaterfall) {
                    NetworkWaterfall(
                        events = filteredEvents.filterIsInstance<TelemetryDisplayEvent.Network>(),
                    )
                } else if (selectedFilter == CategoryFilter.Network) {
                    NetworkTable(
                        filteredEvents.filterIsInstance<TelemetryDisplayEvent.Network>(),
                        listState,
                        timeFormat,
                        colors.text.normal,
                        selectedEvent = selectedEvent,
                        onEventSelected = { event ->
                            // Multi-select for diff: shift-like behavior using diffLeft/diffRight
                            if (diffLeft == null) {
                                diffLeft = event
                                selectedEvent = event
                            } else if (diffRight == null && event != diffLeft) {
                                diffRight = event
                                selectedEvent = event
                            } else {
                                // Reset diff selection
                                diffLeft = event
                                diffRight = null
                                showDiff = false
                                selectedEvent = if (selectedEvent == event) null else event
                            }
                        },
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
                                    onClick = { selectedEvent = if (selectedEvent == event) null else event },
                                    indented = indented,
                                )
                            }
                        }

                        groupedItems.forEach { listItem ->
                            when (listItem) {
                                is EventListItem.Single -> {
                                    emitEventRow(listItem.event, "single")
                                }
                                is EventListItem.Group -> {
                                    val groupId = "${listItem.categoryKey}_${listItem.events.first().timestamp}"
                                    item(key = "group_header_$groupId") {
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

            // Detail panel with draggable divider (shown when an event is selected)
            val selected = selectedEvent
            if (selected != null) {
                val density = LocalDensity.current
                var detailWidthDp by remember {
                    mutableStateOf(DETAIL_PANEL_WIDTH_DEFAULT.dp)
                }

                // Draggable divider — 6dp hit target, 1px visual line
                Box(
                    modifier = Modifier
                        .width(6.dp)
                        .fillMaxHeight()
                        .pointerHoverIcon(PointerIcon(java.awt.Cursor(java.awt.Cursor.W_RESIZE_CURSOR)))
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDrag = { change, dragAmount ->
                                    change.consume()
                                    val deltaDp = with(density) { (-dragAmount.x).toDp() }
                                    detailWidthDp = (detailWidthDp + deltaDp)
                                        .coerceIn(DETAIL_PANEL_WIDTH_MIN.dp, DETAIL_PANEL_WIDTH_MAX.dp)
                                },
                                onDragEnd = { /* width persisted in memory only */ },
                            )
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .width(1.dp)
                            .fillMaxHeight()
                            .background(colors.text.normal.copy(alpha = 0.1f)),
                    )
                }

                TelemetryDetailPanel(
                    event = selected,
                    timeFormat = timeFormat,
                    textColor = colors.text.normal,
                    onClose = { selectedEvent = null },
                    onOpenSource = onOpenSource,
                    screenshotLoader = screenshotLoader,
                    modifier = Modifier.width(detailWidthDp),
                )
            }
        }
    }

    // Auto-scroll to top when new events arrive and user is near top
    LaunchedEffect(filteredEvents.size) {
        if (listState.firstVisibleItemIndex <= 2) {
            listState.animateScrollToItem(0)
        }
    }
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
        modifier = Modifier
            .fillMaxWidth()
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
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (isSelected) Modifier.background(textColor.copy(alpha = 0.08f))
                else Modifier
            )
            .clickable(onClick = onClick)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(start = if (indented) 16.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .clickable(onClick = onToggleBookmark)
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(start = 4.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
        ) {
            Text(
                if (isBookmarked) "\u2605" else "\u2606",
                fontSize = 10.sp,
                color = if (isBookmarked) Color(0xFFFFD43B) else textColor.copy(alpha = 0.25f),
            )
        }
        Box(modifier = Modifier.weight(1f)) {
            TelemetryEventRow(event, timeFormat, textColor)
        }
    }
}

@Composable
private fun TelemetryEventRow(
    event: TelemetryDisplayEvent,
    timeFormat: SimpleDateFormat,
    textColor: Color,
) {
    val formattedTime = remember(event.timestamp) {
        timeFormat.format(Date(event.timestamp))
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp),
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
            imageVector = when (event) {
                is TelemetryDisplayEvent.Network -> AppIcons.Network
                is TelemetryDisplayEvent.Navigation -> AppIcons.Navigation
                is TelemetryDisplayEvent.Log -> AppIcons.Logs
                is TelemetryDisplayEvent.Os -> AppIcons.Os
                is TelemetryDisplayEvent.Custom -> AppIcons.Custom
                is TelemetryDisplayEvent.Failure -> when (event.type) {
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
            is TelemetryDisplayEvent.Custom -> CustomSummary(event, textColor)
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

internal fun networkStatusColor(statusCode: Int, error: String?, textColor: Color): Color = when {
    error != null || statusCode == 0 -> Color(0xFFFF6B6B)      // Error / failed - bright red
    statusCode in 200..299 -> Color(0xFF51CF66)                 // 2xx success - bright green
    statusCode in 300..399 -> Color(0xFFFFD43B)                 // 3xx redirect - bright yellow
    statusCode >= 400 -> Color(0xFFFF6B6B)                      // 4xx/5xx - bright red
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

private val networkColumns = listOf(
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
            modifier = Modifier
                .fillMaxWidth()
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
                    modifier = Modifier
                        .fillMaxWidth()
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
                        Text(formattedTime, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = textColor.copy(alpha = 0.5f), maxLines = 1)
                    }
                    // Method
                    Box(modifier = Modifier.width(networkColumns[1].width.dp).padding(horizontal = 6.dp)) {
                        Text(event.method, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
                    }
                    // Status
                    Box(modifier = Modifier.width(networkColumns[2].width.dp).padding(horizontal = 6.dp)) {
                        Text("${event.statusCode}", fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
                    }
                    // Host
                    Box(modifier = Modifier.width(networkColumns[3].width.dp).padding(horizontal = 6.dp)) {
                        Text(event.host ?: "", fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = textColor.copy(alpha = 0.85f), maxLines = 1)
                    }
                    // Path
                    Box(modifier = Modifier.width(networkColumns[4].width.dp).padding(horizontal = 6.dp)) {
                        Text(event.path ?: event.url, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = textColor.copy(alpha = 0.85f), maxLines = 1)
                    }
                    // Duration
                    Box(modifier = Modifier.width(networkColumns[5].width.dp).padding(horizontal = 6.dp)) {
                        Text("${event.durationMs}ms", fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = textColor.copy(alpha = 0.7f), maxLines = 1)
                    }
                    // Error
                    Box(modifier = Modifier.width(networkColumns[6].width.dp).padding(horizontal = 6.dp)) {
                        Text(event.error ?: "", fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = Color(0xFFE06060), maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun LogSummary(event: TelemetryDisplayEvent.Log, textColor: Color) {
    val levelLetter = when (event.level) {
        2 -> "V"
        3 -> "D"
        4 -> "I"
        5 -> "W"
        6 -> "E"
        7 -> "A"
        else -> "?"
    }
    val color = when (event.level) {
        2 -> textColor.copy(alpha = 0.4f)    // Verbose
        3 -> textColor.copy(alpha = 0.6f)    // Debug
        4 -> textColor.copy(alpha = 0.85f)   // Info
        5 -> Color(0xFFE0C040)               // Warning - yellow
        6 -> Color(0xFFE06060)               // Error - red
        7 -> Color(0xFFFF4040)               // Assert - bright red
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
private fun CustomSummary(event: TelemetryDisplayEvent.Custom, textColor: Color) {
    val propsText = if (event.properties.isNotEmpty()) {
        " {${event.properties.entries.joinToString(", ") { "${it.key}:${it.value}" }}}"
    } else {
        ""
    }

    Text(
        "${event.name}$propsText",
        fontSize = 11.sp,
        fontFamily = FontFamily.Monospace,
        color = textColor.copy(alpha = 0.85f),
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
        color = Color(0xFF74C0FC),  // light blue
        maxLines = 1,
    )
}

@Composable
private fun OsSummary(event: TelemetryDisplayEvent.Os, textColor: Color) {
    val d = event.details
    val detailsText = if (d != null && d.isNotEmpty()) {
        " ${d.entries.joinToString(", ") { "${it.key}:${it.value}" }}"
    } else {
        ""
    }
    val color = when (event.kind) {
        "foreground" -> Color(0xFF51CF66)                   // green
        "background" -> Color(0xFFFFA94D)                   // orange
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
    val color = when (event.severity) {
        "critical" -> Color(0xFFFF4040)  // bright red
        "high" -> Color(0xFFFF6B6B)      // red
        "medium" -> Color(0xFFE0C040)    // yellow
        "low" -> textColor.copy(alpha = 0.7f)
        else -> textColor.copy(alpha = 0.85f)
    }
    val typeLabel = when (event.type) {
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
    val text = when (event.subType) {
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
    val color = when (event.subType) {
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
    }.trim()
    val text = "[${event.health.uppercase()}] $metrics ($changed)"
    val color = when (event.health) {
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
    val color = when {
        !event.success -> Color(0xFFFF6B6B)
        event.durationMs > 5000 -> Color(0xFFFFA94D)
        else -> Color(0xFF51CF66)
    }
    Text(
        "${event.toolName} $status$errorSuffix",
        fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1,
    )
}

@Composable
private fun A11ySummary(event: TelemetryDisplayEvent.Accessibility, textColor: Color) {
    val color = if (event.newViolations > 0) Color(0xFFFFA94D) else Color(0xFF51CF66)
    val text = "${event.newViolations} violations (${event.packageName.substringAfterLast('.')})"
    Text(text, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
}

/**
 * Generates sample telemetry events for Fake/development mode.
 */
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
            requestHeaders = mapOf("Accept" to "application/json", "Authorization" to "Bearer tok_xxx"),
            responseHeaders = mapOf("Content-Type" to "application/json", "X-Request-Id" to "abc-123"),
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
        TelemetryDisplayEvent.Custom(
            timestamp = now - 6000,
            name = "button_click",
            properties = mapOf("screen" to "home", "button" to "refresh"),
        ),
        TelemetryDisplayEvent.Custom(
            timestamp = now - 7000,
            name = "purchase_completed",
            properties = mapOf("item" to "premium", "price" to "9.99"),
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
            stackTrace = listOf(
                StackTraceFrame("com.example.app.UserRepository", "getUser", "UserRepository.kt", 42, true),
                StackTraceFrame("com.example.app.ProfileViewModel", "loadProfile", "ProfileViewModel.kt", 28, true),
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
            stackTrace = listOf(
                StackTraceFrame("com.example.app.CacheManager", "writeCache", "CacheManager.kt", 88, true),
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
            detailsJson = """{"screenName":"SettingsScreen","windowCount":3,"foregroundActivity":"com.example.app.SettingsActivity"}""",
        ),
    )
}

/**
 * Export and session management popup menu.
 */
@Composable
private fun ExportSessionMenu(
    events: List<TelemetryDisplayEvent>,
    filteredEvents: List<TelemetryDisplayEvent>,
    selectedFilter: CategoryFilter,
    onDismiss: () -> Unit,
    onLoadSession: (List<TelemetryDisplayEvent>) -> Unit,
    textColor: Color,
) {
    val menuItemModifier = Modifier
        .fillMaxWidth()
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 6.dp)

    Box(
        modifier = Modifier
            .width(200.dp)
            .background(textColor.copy(alpha = 0.08f), RoundedCornerShape(6.dp))
            .padding(4.dp),
    ) {
        Column {
            // Export JSON
            Box(
                modifier = Modifier
                    .clickable {
                        val content = TelemetryExporter.exportAsJson(filteredEvents)
                        SwingFileSaver.save("telemetry.json", content) {}
                        onDismiss()
                    }
                    .then(menuItemModifier),
            ) {
                Text("Export JSON", fontSize = 11.sp, color = textColor)
            }

            // Export CSV
            Box(
                modifier = Modifier
                    .clickable {
                        val content = TelemetryExporter.exportAsCsv(filteredEvents)
                        SwingFileSaver.save("telemetry.csv", content) {}
                        onDismiss()
                    }
                    .then(menuItemModifier),
            ) {
                Text("Export CSV", fontSize = 11.sp, color = textColor)
            }

            // Export HAR (only if network events exist)
            val networkEvents = filteredEvents.filterIsInstance<TelemetryDisplayEvent.Network>()
            if (networkEvents.isNotEmpty() || selectedFilter == CategoryFilter.Network) {
                Box(
                    modifier = Modifier
                        .clickable {
                            val content = TelemetryExporter.exportAsHar(networkEvents)
                            SwingFileSaver.save("telemetry.har", content) {}
                            onDismiss()
                        }
                        .then(menuItemModifier),
                ) {
                    Text("Export HAR (Network)", fontSize = 11.sp, color = textColor)
                }
            }

            // Divider
            Box(Modifier.fillMaxWidth().height(1.dp).background(textColor.copy(alpha = 0.1f)))

            // Save Session
            Box(
                modifier = Modifier
                    .clickable {
                        val chooser = JFileChooser()
                        chooser.selectedFile = File("session.automobile-session")
                        chooser.fileFilter = FileNameExtensionFilter("AutoMobile Session", "automobile-session")
                        if (chooser.showSaveDialog(null) == JFileChooser.APPROVE_OPTION) {
                            var file = chooser.selectedFile
                            if (!file.name.endsWith(".automobile-session")) {
                                file = File(file.absolutePath + ".automobile-session")
                            }
                            SessionManager.saveSession(events, file)
                        }
                        onDismiss()
                    }
                    .then(menuItemModifier),
            ) {
                Text("Save Session", fontSize = 11.sp, color = textColor)
            }

            // Load Session
            Box(
                modifier = Modifier
                    .clickable {
                        val chooser = JFileChooser()
                        chooser.fileFilter = FileNameExtensionFilter("AutoMobile Session", "automobile-session")
                        if (chooser.showOpenDialog(null) == JFileChooser.APPROVE_OPTION) {
                            val loaded = SessionManager.loadSession(chooser.selectedFile)
                            if (loaded != null) {
                                onLoadSession(loaded)
                            }
                        }
                        onDismiss()
                    }
                    .then(menuItemModifier),
            ) {
                Text("Load Session", fontSize = 11.sp, color = textColor)
            }
        }
    }
}

