package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlin.math.max
import kotlin.math.min

/**
 * A time-range brush composable that shows event density as a histogram.
 * Users can drag to select a time range, filtering the event list.
 *
 * @param events All events (unfiltered by time).
 * @param selectedRange Current selected time range, or null for no selection.
 * @param onRangeChanged Called when the user drags to select a range, or null to clear.
 */
@Composable
fun TimeRangeBrush(
    events: List<TelemetryDisplayEvent>,
    selectedRange: LongRange?,
    onRangeChanged: (LongRange?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val barColor = colors.text.normal.copy(alpha = 0.3f)
    val selectionColor = Color(0xFF74C0FC).copy(alpha = 0.25f)
    val selectionBorderColor = Color(0xFF74C0FC).copy(alpha = 0.6f)

    // Compute histogram buckets
    val bucketCount = 80
    val histogram = remember(events, bucketCount) {
        if (events.isEmpty()) return@remember HistogramData(0L, 0L, IntArray(0))
        val minTs = events.minOf { it.timestamp }
        val maxTs = events.maxOf { it.timestamp }
        val range = max(maxTs - minTs, 1L)
        val counts = IntArray(bucketCount)
        events.forEach { event ->
            val bucket = ((event.timestamp - minTs) * (bucketCount - 1) / range).toInt()
                .coerceIn(0, bucketCount - 1)
            counts[bucket]++
        }
        HistogramData(minTs, maxTs, counts)
    }

    var dragStartX by remember { mutableStateOf<Float?>(null) }
    var dragCurrentX by remember { mutableStateOf<Float?>(null) }

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .pointerInput(histogram) {
                detectDragGestures(
                    onDragStart = { offset ->
                        dragStartX = offset.x
                        dragCurrentX = offset.x
                    },
                    onDrag = { change, _ ->
                        change.consume()
                        dragCurrentX = change.position.x
                        // Compute range during drag
                        val sx = dragStartX ?: return@detectDragGestures
                        val cx = dragCurrentX ?: return@detectDragGestures
                        val width = size.width.toFloat()
                        if (width > 0 && histogram.counts.isNotEmpty()) {
                            val left = min(sx, cx).coerceIn(0f, width) / width
                            val right = max(sx, cx).coerceIn(0f, width) / width
                            val tsRange = histogram.maxTs - histogram.minTs
                            val startTs = histogram.minTs + (left * tsRange).toLong()
                            val endTs = histogram.minTs + (right * tsRange).toLong()
                            onRangeChanged(startTs..endTs)
                        }
                    },
                    onDragEnd = {
                        dragStartX = null
                        dragCurrentX = null
                    },
                    onDragCancel = {
                        dragStartX = null
                        dragCurrentX = null
                        onRangeChanged(null)
                    },
                )
            },
    ) {
        val width = size.width
        val height = size.height
        if (histogram.counts.isEmpty()) return@Canvas

        val maxCount = histogram.counts.max().coerceAtLeast(1)
        val barWidth = width / histogram.counts.size

        // Draw histogram bars
        histogram.counts.forEachIndexed { index, count ->
            val barHeight = (count.toFloat() / maxCount) * (height - 4f)
            drawRect(
                color = barColor,
                topLeft = Offset(index * barWidth, height - barHeight),
                size = Size(barWidth - 1f, barHeight),
            )
        }

        // Draw selection overlay
        val range = selectedRange
        if (range != null && histogram.maxTs > histogram.minTs) {
            val tsRange = (histogram.maxTs - histogram.minTs).toFloat()
            val leftFrac = ((range.first - histogram.minTs).toFloat() / tsRange).coerceIn(0f, 1f)
            val rightFrac = ((range.last - histogram.minTs).toFloat() / tsRange).coerceIn(0f, 1f)
            val leftX = leftFrac * width
            val rightX = rightFrac * width
            drawRect(
                color = selectionColor,
                topLeft = Offset(leftX, 0f),
                size = Size(rightX - leftX, height),
            )
            // Left border
            drawLine(selectionBorderColor, Offset(leftX, 0f), Offset(leftX, height), strokeWidth = 1.5f)
            // Right border
            drawLine(selectionBorderColor, Offset(rightX, 0f), Offset(rightX, height), strokeWidth = 1.5f)
        }
    }
}

private data class HistogramData(
    val minTs: Long,
    val maxTs: Long,
    val counts: IntArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is HistogramData) return false
        return minTs == other.minTs && maxTs == other.maxTs && counts.contentEquals(other.counts)
    }
    override fun hashCode(): Int {
        var result = minTs.hashCode()
        result = 31 * result + maxTs.hashCode()
        result = 31 * result + counts.contentHashCode()
        return result
    }
}
