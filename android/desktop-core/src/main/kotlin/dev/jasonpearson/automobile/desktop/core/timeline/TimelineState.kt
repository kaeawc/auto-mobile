package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

class TimelineState {
    var visibleStartMs: Long by mutableStateOf(0L)
    var visibleEndMs: Long by mutableStateOf(1L)
    var selectedTimestampMs: Long? by mutableStateOf(null)

    fun visibleDurationMs(): Long = visibleEndMs - visibleStartMs

    fun zoomIn(pivotFraction: Float = 0.5f) {
        val duration = visibleDurationMs()
        val shrink = duration * 0.20f
        val leftShrink = shrink * pivotFraction
        val rightShrink = shrink * (1f - pivotFraction)
        visibleStartMs += leftShrink.toLong()
        visibleEndMs -= rightShrink.toLong()
        if (visibleEndMs <= visibleStartMs) visibleEndMs = visibleStartMs + 1
    }

    fun zoomOut(pivotFraction: Float = 0.5f) {
        val duration = visibleDurationMs()
        val expand = duration * 0.25f
        val leftExpand = expand * pivotFraction
        val rightExpand = expand * (1f - pivotFraction)
        visibleStartMs -= leftExpand.toLong()
        visibleEndMs += rightExpand.toLong()
    }

    fun panBy(fractionOfVisible: Float) {
        val shift = (visibleDurationMs() * fractionOfVisible).toLong()
        visibleStartMs += shift
        visibleEndMs += shift
    }

    fun fitToEvents(spans: List<TimelineSpan>) {
        if (spans.isEmpty()) {
            visibleStartMs = 0L
            visibleEndMs = 10_000L
            return
        }
        val minMs = spans.minOf { it.startMs }
        val maxMs = spans.maxOf { it.endMs }
        if (maxMs <= minMs) {
            // Single point in time — center a 10-second window around it
            visibleStartMs = minMs - 5_000L
            visibleEndMs = minMs + 5_000L
            return
        }
        val range = maxMs - minMs
        val padding = (range * 0.05f).toLong().coerceAtLeast(1L)
        visibleStartMs = minMs - padding
        visibleEndMs = maxMs + padding
    }

    fun scrollZoom(scrollDelta: Float, pivotFraction: Float) {
        val factor = 0.05f * scrollDelta
        val duration = visibleDurationMs()
        val change = (duration * factor).toLong()
        val leftChange = (change * pivotFraction).toLong()
        val rightChange = change - leftChange
        visibleStartMs += leftChange
        visibleEndMs -= rightChange
        if (visibleEndMs <= visibleStartMs) visibleEndMs = visibleStartMs + 1
    }

    fun timestampToFraction(timestampMs: Long): Float {
        val duration = visibleDurationMs()
        if (duration <= 0) return 0f
        return (timestampMs - visibleStartMs).toFloat() / duration
    }

    fun fractionToTimestamp(fraction: Float): Long =
        visibleStartMs + (fraction * visibleDurationMs()).toLong()
}

@Composable
fun rememberTimelineState(): TimelineState = remember { TimelineState() }
