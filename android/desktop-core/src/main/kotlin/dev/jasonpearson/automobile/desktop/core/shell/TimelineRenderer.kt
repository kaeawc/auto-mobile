package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private object EventColors {
    val network = Color(0xFF4285F4)
    val navigation = Color(0xFF34A853)
    val failure = Color(0xFFEA4335)
    val performance = Color(0xFFFBBC04)
    val layout = Color(0xFF9334E6)
    val storage = Color(0xFFFF6D01)
    val tool = Color(0xFF607D8B)
    val log = Color(0xFF78909C)
    val other = Color(0xFF9E9E9E)
}

private fun eventColor(event: TelemetryDisplayEvent): Color = when (event) {
    is TelemetryDisplayEvent.Network -> EventColors.network
    is TelemetryDisplayEvent.Navigation -> EventColors.navigation
    is TelemetryDisplayEvent.Failure -> EventColors.failure
    is TelemetryDisplayEvent.Performance -> EventColors.performance
    is TelemetryDisplayEvent.Layout -> EventColors.layout
    is TelemetryDisplayEvent.Storage -> EventColors.storage
    is TelemetryDisplayEvent.ToolCall -> EventColors.tool
    is TelemetryDisplayEvent.Log -> EventColors.log
    else -> EventColors.other
}

private fun eventSummary(event: TelemetryDisplayEvent): String = when (event) {
    is TelemetryDisplayEvent.Network -> "${event.method} ${event.statusCode} ${event.url.take(40)}"
    is TelemetryDisplayEvent.Navigation -> "Nav: ${event.destination}"
    is TelemetryDisplayEvent.Failure -> "${event.type}: ${event.title.take(40)}"
    is TelemetryDisplayEvent.Performance -> "Perf: ${event.health}"
    is TelemetryDisplayEvent.Layout -> "Layout: ${event.subType}"
    is TelemetryDisplayEvent.Storage -> "Storage: ${event.fileName}"
    is TelemetryDisplayEvent.ToolCall -> "Tool: ${event.toolName}"
    is TelemetryDisplayEvent.Log -> "Log: ${event.tag} - ${event.message.take(30)}"
    is TelemetryDisplayEvent.Custom -> "Custom: ${event.name}"
    is TelemetryDisplayEvent.Os -> "OS: ${event.kind}"
    is TelemetryDisplayEvent.Accessibility -> "A11y: ${event.totalViolations} violations"
    is TelemetryDisplayEvent.Memory -> "Memory: ${if (event.passed) "OK" else "FAIL"}"
}

private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
private val labelFont = org.jetbrains.skia.Font().apply { size = 10f }

/**
 * Finds the nearest event to a given x position, returning it only if within [maxDistancePx].
 */
private fun findNearestEvent(
    events: List<TelemetryDisplayEvent>,
    posX: Float,
    minTimestamp: Long,
    pixelsPerMs: Float,
    maxDistancePx: Float = 10f,
): TelemetryDisplayEvent? {
    val nearest = events.minByOrNull {
        kotlin.math.abs((it.timestamp - minTimestamp) * pixelsPerMs - posX)
    } ?: return null
    val nearestX = (nearest.timestamp - minTimestamp) * pixelsPerMs
    return if (kotlin.math.abs(nearestX - posX) < maxDistancePx) nearest else null
}

/**
 * Canvas-based timeline renderer drawing the time axis, grid lines,
 * event markers, and a current-time indicator.
 *
 * Supports horizontal scrolling and zoom via scroll wheel.
 */
@Composable
fun TimelineRenderer(
    events: List<TelemetryDisplayEvent>,
    timelineState: TimelineState,
    selectedEvent: TelemetryDisplayEvent?,
    onEventClicked: (TelemetryDisplayEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val scrollState = rememberScrollState()

    val minTimestamp = events.minOfOrNull { it.timestamp } ?: System.currentTimeMillis()
    val maxTimestamp = maxOf(
        events.maxOfOrNull { it.timestamp } ?: System.currentTimeMillis(),
        System.currentTimeMillis(),
    )

    val basePixelsPerMs = 0.1f * timelineState.zoomLevel
    val totalDurationMs = maxOf(maxTimestamp - minTimestamp, 1000L)
    val totalWidthPx = totalDurationMs * basePixelsPerMs
    val totalWidthDp = with(density) { totalWidthPx.toDp() }

    LaunchedEffect(scrollState.value, scrollState.maxValue, totalDurationMs) {
        val viewportFraction = if (totalWidthPx > 0) {
            scrollState.value.toFloat() / maxOf(totalWidthPx, 1f)
        } else 0f
        val viewportDurationMs = if (basePixelsPerMs > 0) {
            (scrollState.viewportSize / basePixelsPerMs).toLong()
        } else totalDurationMs
        val start = minTimestamp + (viewportFraction * totalDurationMs).toLong()
        val end = minOf(start + viewportDurationMs, maxTimestamp)
        timelineState.visibleTimeRange = start..end
    }

    var hoveredEvent by remember { mutableStateOf<TelemetryDisplayEvent?>(null) }
    var hoverPosition by remember { mutableStateOf(Offset.Zero) }

    val axisColor = Color(0xFF616161)
    val gridColor = Color(0x33888888)
    val selectedColor = Color(0xFFFFD600)
    val currentTimeColor = Color(0xFFFF5252)

    Canvas(
        modifier = modifier
            .horizontalScroll(scrollState)
            .width(maxOf(totalWidthDp, 200.dp))
            .fillMaxSize()
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        when (event.type) {
                            PointerEventType.Scroll -> {
                                val scrollDelta = event.changes.firstOrNull()?.scrollDelta?.y ?: 0f
                                timelineState.zoomLevel = (timelineState.zoomLevel - scrollDelta * 0.1f)
                                    .coerceIn(0.1f, 20.0f)
                            }
                            PointerEventType.Press -> {
                                val pos = event.changes.firstOrNull()?.position ?: continue
                                val nearest = findNearestEvent(events, pos.x, minTimestamp, basePixelsPerMs)
                                if (nearest != null) {
                                    onEventClicked(nearest)
                                    timelineState.selectedEventTimestamp = nearest.timestamp
                                }
                            }
                            PointerEventType.Move -> {
                                val pos = event.changes.firstOrNull()?.position ?: continue
                                hoverPosition = pos
                                hoveredEvent = findNearestEvent(events, pos.x, minTimestamp, basePixelsPerMs)
                            }
                        }
                    }
                }
            }
    ) {
        val canvasHeight = size.height
        val axisY = canvasHeight - 20f
        val markerY = axisY - 16f

        drawLine(
            color = axisColor,
            start = Offset(0f, axisY),
            end = Offset(size.width, axisY),
            strokeWidth = 1f,
        )

        val gridIntervalMs = computeGridInterval(totalDurationMs, timelineState.zoomLevel)
        val firstTick = ((minTimestamp / gridIntervalMs) + 1) * gridIntervalMs
        var tick = firstTick
        while (tick <= maxTimestamp) {
            val x = (tick - minTimestamp) * basePixelsPerMs
            drawLine(
                color = gridColor,
                start = Offset(x, 0f),
                end = Offset(x, axisY),
                strokeWidth = 1f,
            )
            drawLine(
                color = axisColor,
                start = Offset(x, axisY),
                end = Offset(x, axisY + 4f),
                strokeWidth = 1f,
            )
            drawTimeLabel(x, axisY + 14f, tick, axisColor)
            tick += gridIntervalMs
        }

        for (evt in events) {
            val x = (evt.timestamp - minTimestamp) * basePixelsPerMs
            val isSelected = selectedEvent?.timestamp == evt.timestamp
            val radius = if (isSelected) 6f else 4f

            drawCircle(
                color = eventColor(evt),
                radius = radius,
                center = Offset(x, markerY),
            )

            if (isSelected) {
                drawCircle(
                    color = selectedColor,
                    radius = radius + 2f,
                    center = Offset(x, markerY),
                    style = Stroke(width = 2f),
                )
            }
        }

        val currentX = (System.currentTimeMillis() - minTimestamp) * basePixelsPerMs
        if (currentX in 0f..size.width) {
            drawLine(
                color = currentTimeColor,
                start = Offset(currentX, 0f),
                end = Offset(currentX, axisY),
                strokeWidth = 2f,
            )
            drawCircle(
                color = currentTimeColor,
                radius = 3f,
                center = Offset(currentX, 4f),
            )
        }

        hoveredEvent?.let { evt ->
            val summary = eventSummary(evt)
            val tooltipX = hoverPosition.x + 12f
            val tooltipY = hoverPosition.y - 20f
            val textWidth = labelFont.measureTextWidth(summary)
            drawRoundRect(
                color = Color(0xDD333333),
                topLeft = Offset(tooltipX, tooltipY - 12f),
                size = Size(textWidth + 8f, 20f),
                cornerRadius = CornerRadius(4f),
            )
            drawTooltipText(tooltipX + 4f, tooltipY, summary, Color.White)
        }
    }
}

private fun computeGridInterval(totalDurationMs: Long, zoomLevel: Float): Long {
    val visibleDurationMs = totalDurationMs / zoomLevel
    return when {
        visibleDurationMs < 30_000 -> 1_000L
        visibleDurationMs < 120_000 -> 5_000L
        visibleDurationMs < 600_000 -> 30_000L
        visibleDurationMs < 3_600_000 -> 60_000L
        visibleDurationMs < 21_600_000 -> 300_000L
        visibleDurationMs < 86_400_000 -> 3_600_000L
        else -> 21_600_000L
    }
}

private fun DrawScope.drawTimeLabel(x: Float, y: Float, timestampMs: Long, color: Color) {
    drawTooltipText(x, y, timeFormat.format(Date(timestampMs)), color)
}

private fun DrawScope.drawTooltipText(x: Float, y: Float, text: String, color: Color) {
    drawContext.canvas.nativeCanvas.apply {
        val paint = org.jetbrains.skia.Paint().apply {
            this.color = org.jetbrains.skia.Color.makeARGB(
                (color.alpha * 255).toInt(),
                (color.red * 255).toInt(),
                (color.green * 255).toInt(),
                (color.blue * 255).toInt(),
            )
        }
        drawString(text, x, y, labelFont, paint)
    }
}
