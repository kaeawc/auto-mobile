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

    fun visibleDurationMs(): Long = (visibleEndMs - visibleStartMs).coerceAtLeast(1L)

    fun zoomIn(pivotFraction: Float = 0.5f) {
        val duration = visibleDurationMs()
        val shrink = (duration * 0.1f).toLong().coerceAtLeast(1L)
        visibleStartMs += (shrink * pivotFraction).toLong()
        visibleEndMs -= (shrink * (1f - pivotFraction)).toLong()
        if (visibleEndMs <= visibleStartMs) visibleEndMs = visibleStartMs + 1
    }

    fun zoomOut(pivotFraction: Float = 0.5f) {
        val duration = visibleDurationMs()
        val expand = (duration * 0.125f).toLong().coerceAtLeast(1L)
        visibleStartMs -= (expand * pivotFraction).toLong()
        visibleEndMs += (expand * (1f - pivotFraction)).toLong()
    }

    fun panBy(fractionOfVisible: Float) {
        val shift = (visibleDurationMs() * fractionOfVisible).toLong()
        visibleStartMs += shift
        visibleEndMs += shift
    }

    fun fitToEvents(spans: List<TimelineSpan>) {
        if (spans.isEmpty()) {
            visibleStartMs = System.currentTimeMillis() - 10_000L
            visibleEndMs = System.currentTimeMillis()
            return
        }
        val minTs = spans.minOf { it.startMs }
        val maxTs = spans.maxOf { it.endMs }
        val range = (maxTs - minTs).coerceAtLeast(1L)
        val padding = (range * 0.05f).toLong().coerceAtLeast(100L)
        visibleStartMs = minTs - padding
        visibleEndMs = maxTs + padding
    }

    fun scrollZoom(scrollDelta: Float, pivotFraction: Float) {
        val factor = 0.05f * scrollDelta
        val duration = visibleDurationMs()
        val change = (duration * factor).toLong()
        visibleStartMs -= (change * pivotFraction).toLong()
        visibleEndMs += (change * (1f - pivotFraction)).toLong()
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
