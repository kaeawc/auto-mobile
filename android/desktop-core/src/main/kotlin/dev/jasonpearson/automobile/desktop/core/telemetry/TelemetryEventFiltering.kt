package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons

internal const val GROUP_THRESHOLD = 3

/** Returns a category key used to group consecutive same-type events. */
internal fun TelemetryDisplayEvent.categoryKey(): String =
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
internal sealed class EventListItem {
  data class Single(val event: TelemetryDisplayEvent) : EventListItem()

  data class Group(
    val categoryKey: String,
    val events: List<TelemetryDisplayEvent>,
    val isExpanded: Boolean,
  ) : EventListItem()
}

internal data class RenderedTelemetryRow(
  val event: TelemetryDisplayEvent,
  val startTimestamp: Long,
  val endTimestamp: Long,
)

/**
 * Processes a flat event list into [EventListItem]s, collapsing runs of 3+ consecutive
 * same-category events into groups.
 */
internal fun groupEvents(
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
        ),
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

internal const val DETAIL_PANEL_WIDTH_KEY = "automobile.telemetry.detailPanelWidth"
internal const val DETAIL_PANEL_WIDTH_DEFAULT = 320
internal const val DETAIL_PANEL_WIDTH_MIN = 200
internal const val DETAIL_PANEL_WIDTH_MAX = 600

/** Allowed max-event buffer sizes for the telemetry dashboard. */
internal val MAX_EVENTS_OPTIONS = listOf(500, 1000, 5000, 10_000)
internal const val DEFAULT_MAX_EVENTS = 1000

internal enum class CategoryFilter(
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
internal fun TelemetryDisplayEvent.durationMs(): Long =
  when (this) {
    is TelemetryDisplayEvent.Network -> durationMs
    is TelemetryDisplayEvent.ToolCall -> durationMs
    is TelemetryDisplayEvent.Layout -> durationMs ?: 0L
    else -> 0L
  }

internal fun groupedRowIndexForTimestamp(
  renderedRows: List<RenderedTelemetryRow>,
  timestamp: Long,
): Int {
  val nearestRow = renderedRows.indexOfFirst { row ->
    timestamp in row.startTimestamp..row.endTimestamp || row.startTimestamp >= timestamp
  }
  return if (nearestRow >= 0) nearestRow else renderedRows.lastIndex
}

internal fun buildRenderedRows(groupedItems: List<EventListItem>): List<RenderedTelemetryRow> =
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
            ),
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
            ),
          )
          if (listItem.isExpanded) {
            listItem.events.forEach { event ->
              val dur = event.durationMs()
              add(
                RenderedTelemetryRow(
                  event = event,
                  startTimestamp = event.timestamp,
                  endTimestamp = event.timestamp + dur,
                ),
              )
            }
          }
        }
      }
    }
  }

internal data class FilterInputs(
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
internal fun categoryOf(event: TelemetryDisplayEvent): CategoryFilter? =
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
internal fun incrementCount(
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
internal fun trimEvents(
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
internal fun buildFilteredList(
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
