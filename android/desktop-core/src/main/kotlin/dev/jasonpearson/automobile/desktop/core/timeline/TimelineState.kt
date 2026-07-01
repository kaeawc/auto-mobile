package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

class TimelineState(
  initialStartMs: Long = 0L,
  initialEndMs: Long = 60_000L,
) {
  var visibleStartMs: Long by mutableLongStateOf(initialStartMs)
  var visibleEndMs: Long by mutableLongStateOf(initialEndMs)
  var selectedTimestampMs: Long? by mutableStateOf(null)

  fun visibleDurationMs(): Long = (visibleEndMs - visibleStartMs).coerceAtLeast(1L)

  fun scrollZoom(scrollDelta: Float, pivotFraction: Float) {
    val factor = if (scrollDelta > 0) 1.1f else 1f / 1.1f
    val duration = visibleDurationMs()
    val pivot = visibleStartMs + (duration * pivotFraction).toLong()
    val newDuration = (duration * factor).toLong().coerceIn(100L, Long.MAX_VALUE / 2)
    visibleStartMs = pivot - (newDuration * pivotFraction).toLong()
    visibleEndMs = visibleStartMs + newDuration
  }

  fun panBy(fractionOfVisible: Float) {
    val delta = (visibleDurationMs() * fractionOfVisible).toLong()
    visibleStartMs += delta
    visibleEndMs += delta
  }

  fun zoomIn() = scrollZoom(-1f, 0.5f)

  fun zoomOut() = scrollZoom(1f, 0.5f)

  fun fitToEvents(spans: List<TimelineSpan>) {
    if (spans.isEmpty()) return
    val minMs = spans.minOf { it.startMs }
    val maxMs = spans.maxOf { it.endMs }
    val padding = ((maxMs - minMs) * 0.05).toLong().coerceAtLeast(500L)
    visibleStartMs = minMs - padding
    visibleEndMs = maxMs + padding
  }

  fun timestampToFraction(timestampMs: Long): Float =
    (timestampMs - visibleStartMs).toFloat() / visibleDurationMs().toFloat()

  fun fractionToTimestamp(fraction: Float): Long =
    visibleStartMs + (visibleDurationMs() * fraction).toLong()
}

@Composable
fun rememberTimelineState(
  initialStartMs: Long = 0L,
  initialEndMs: Long = 60_000L,
): TimelineState = remember { TimelineState(initialStartMs, initialEndMs) }
