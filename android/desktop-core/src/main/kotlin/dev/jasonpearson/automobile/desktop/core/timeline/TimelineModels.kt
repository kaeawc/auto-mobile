package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent

enum class TimelineCategory(val color: Color, val laneIndex: Int, val label: String) {
  Network(Color(0xFF42A5F5), 0, "Network"),
  ToolCall(Color(0xFF7E57C2), 0, "Tools"),
  Navigation(Color(0xFF66BB6A), 1, "Nav"),
  Failure(Color(0xFFEF5350), 1, "Failures"),
  Os(Color(0xFFFF7043), 1, "OS"),
  Accessibility(Color(0xFFAB47BC), 1, "A11y"),
  Log(Color(0xFF78909C), 2, "Logs"),
  Storage(Color(0xFFFFA726), 2, "Storage"),
  Layout(Color(0xFF26C6DA), 2, "Layout"),
  Memory(Color(0xFFD4E157), 2, "Memory"),
  Performance(Color(0xFFEC407A), 2, "Perf"),
}

fun TelemetryDisplayEvent.toTimelineCategory(): TimelineCategory =
  when (this) {
    is TelemetryDisplayEvent.Network -> TimelineCategory.Network
    is TelemetryDisplayEvent.ToolCall -> TimelineCategory.ToolCall
    is TelemetryDisplayEvent.Navigation -> TimelineCategory.Navigation
    is TelemetryDisplayEvent.Failure -> TimelineCategory.Failure
    is TelemetryDisplayEvent.Os -> TimelineCategory.Os
    is TelemetryDisplayEvent.Accessibility -> TimelineCategory.Accessibility
    is TelemetryDisplayEvent.Log -> TimelineCategory.Log
    is TelemetryDisplayEvent.Storage -> TimelineCategory.Storage
    is TelemetryDisplayEvent.Layout -> TimelineCategory.Layout
    is TelemetryDisplayEvent.Memory -> TimelineCategory.Memory
    is TelemetryDisplayEvent.Performance -> TimelineCategory.Performance
  }

data class TimelineSpan(
  val event: TelemetryDisplayEvent,
  val startMs: Long,
  val endMs: Long,
  val category: TimelineCategory,
  val isFiltered: Boolean,
)

/**
 * Build timeline spans from display events. Point events get a minimum 50ms duration so they remain
 * visible. Duration-bearing events use their actual duration.
 */
fun buildTimelineSpans(
  events: List<TelemetryDisplayEvent>,
  filteredCategories: Set<TimelineCategory> = emptySet(),
): List<TimelineSpan> = events.map { event ->
  val category = event.toTimelineCategory()
  val durationMs =
    when (event) {
      is TelemetryDisplayEvent.Network -> event.durationMs
      is TelemetryDisplayEvent.ToolCall -> event.durationMs
      is TelemetryDisplayEvent.Layout -> event.durationMs ?: 0L
      else -> 0L
    }
  val effectiveDuration = if (durationMs > 0) durationMs else 50L
  TimelineSpan(
    event = event,
    startMs = event.timestamp,
    endMs = event.timestamp + effectiveDuration,
    category = category,
    isFiltered = category in filteredCategories,
  )
}

/** Returns the sorted distinct lane indices that have at least one span. */
fun activeLanes(spans: List<TimelineSpan>): List<Int> =
  spans.map { it.category.laneIndex }.distinct().sorted()
