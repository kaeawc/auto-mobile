package dev.jasonpearson.automobile.desktop.core.timeline

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private const val TIME_AXIS_HEIGHT = 16f
private const val LANE_LABEL_WIDTH = 48f
private const val MIN_SPAN_WIDTH = 2f
private const val SPAN_HEIGHT_FRACTION = 0.6f

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
fun TimelineCanvas(
    spans: List<TimelineSpan>,
    activeLanes: List<Int>,
    state: TimelineState,
    onEventClicked: (TelemetryDisplayEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val textMeasurer = rememberTextMeasurer()
    val timeFormat = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }
    val isMac = remember { System.getProperty("os.name")?.lowercase()?.contains("mac") == true }
    val infoColor = colors.text.info
    val textColor = colors.text.normal

    Box(
        modifier = modifier
            .onPointerEvent(PointerEventType.Scroll) { event ->
                val change = event.changes.first()
                val isZoomModifier = if (isMac) event.keyboardModifiers.isMetaPressed else event.keyboardModifiers.isCtrlPressed
                if (isZoomModifier) {
                    val pivotFraction = (change.position.x - LANE_LABEL_WIDTH) /
                        (change.position.x.coerceAtLeast(1f))
                    state.scrollZoom(change.scrollDelta.y, pivotFraction.coerceIn(0f, 1f))
                    change.consume()
                }
            }
            .pointerInput(Unit) {
                detectDragGestures { _, dragAmount ->
                    state.panBy(-dragAmount.x / size.width)
                }
            }
            .pointerInput(spans) {
                detectTapGestures { offset ->
                    val chartWidth = size.width - LANE_LABEL_WIDTH
                    if (chartWidth <= 0 || offset.x < LANE_LABEL_WIDTH) return@detectTapGestures
                    val fraction = (offset.x - LANE_LABEL_WIDTH) / chartWidth
                    val clickedTs = state.fractionToTimestamp(fraction)
                    state.selectedTimestampMs = clickedTs
                    // Find nearest span
                    val tolerance = (state.visibleDurationMs() * 0.005f).toLong().coerceAtLeast(5L)
                    val nearest = spans.minByOrNull {
                        kotlin.math.abs(it.startMs - clickedTs).coerceAtMost(kotlin.math.abs(it.endMs - clickedTs))
                    }
                    if (nearest != null && (clickedTs in (nearest.startMs - tolerance)..(nearest.endMs + tolerance))) {
                        onEventClicked(nearest.event)
                    }
                }
            }
    ) {
        Canvas(Modifier.fillMaxSize()) {
            if (activeLanes.isEmpty()) return@Canvas
            val chartLeft = LANE_LABEL_WIDTH
            val chartWidth = size.width - chartLeft
            val chartHeight = size.height - TIME_AXIS_HEIGHT
            if (chartWidth <= 0 || chartHeight <= 0) return@Canvas
            val laneHeight = chartHeight / activeLanes.size

            // Draw lane backgrounds
            activeLanes.forEachIndexed { index, _ ->
                val y = index * laneHeight
                val bgAlpha = if (index % 2 == 0) 0.03f else 0.06f
                drawRect(
                    color = textColor.copy(alpha = bgAlpha),
                    topLeft = Offset(chartLeft, y),
                    size = Size(chartWidth, laneHeight),
                )
            }

            // Draw spans
            for (span in spans) {
                val laneIndex = activeLanes.indexOf(span.category.laneIndex)
                if (laneIndex < 0) continue
                val startFrac = state.timestampToFraction(span.startMs)
                val endFrac = state.timestampToFraction(span.endMs)
                if (endFrac < 0f || startFrac > 1f) continue
                val x1 = (chartLeft + startFrac * chartWidth).coerceAtLeast(chartLeft)
                val x2 = (chartLeft + endFrac * chartWidth).coerceAtMost(chartLeft + chartWidth)
                val spanWidth = (x2 - x1).coerceAtLeast(MIN_SPAN_WIDTH)
                val laneY = laneIndex * laneHeight
                val spanH = laneHeight * SPAN_HEIGHT_FRACTION
                val spanY = laneY + (laneHeight - spanH) / 2
                val alpha = if (span.isFiltered) 0.2f else 1.0f
                drawRoundRect(
                    color = span.category.color.copy(alpha = alpha),
                    topLeft = Offset(x1, spanY),
                    size = Size(spanWidth, spanH),
                    cornerRadius = CornerRadius(2f, 2f),
                )
            }

            // Draw playhead
            state.selectedTimestampMs?.let { ts ->
                val frac = state.timestampToFraction(ts)
                if (frac in 0f..1f) {
                    val x = chartLeft + frac * chartWidth
                    drawLine(
                        color = infoColor.copy(alpha = 0.8f),
                        start = Offset(x, 0f),
                        end = Offset(x, chartHeight),
                        strokeWidth = 1.5f,
                    )
                }
            }

            // Draw time axis ticks
            val tickCount = (chartWidth / 80).toInt().coerceIn(2, 10)
            for (i in 0..tickCount) {
                val frac = i.toFloat() / tickCount
                val x = chartLeft + frac * chartWidth
                val ts = state.fractionToTimestamp(frac)
                drawLine(
                    color = textColor.copy(alpha = 0.2f),
                    start = Offset(x, chartHeight),
                    end = Offset(x, chartHeight + 4f),
                    strokeWidth = 1f,
                )
                val label = timeFormat.format(Date(ts))
                val textResult = textMeasurer.measure(label, style = TextStyle(fontSize = 8.sp))
                drawText(
                    textLayoutResult = textResult,
                    color = textColor.copy(alpha = 0.4f),
                    topLeft = Offset(x - textResult.size.width / 2f, chartHeight + 4f),
                )
            }

            // Draw lane labels
            val laneLabels = mapOf(0 to "Net/Tool", 1 to "Nav/State", 2 to "Diag")
            activeLanes.forEachIndexed { index, laneIdx ->
                val label = laneLabels[laneIdx] ?: ""
                val textResult = textMeasurer.measure(label, style = TextStyle(fontSize = 9.sp))
                val laneY = index * laneHeight + laneHeight / 2 - textResult.size.height / 2
                drawText(
                    textLayoutResult = textResult,
                    color = textColor.copy(alpha = 0.4f),
                    topLeft = Offset(4f, laneY),
                )
            }
        }
    }
}
