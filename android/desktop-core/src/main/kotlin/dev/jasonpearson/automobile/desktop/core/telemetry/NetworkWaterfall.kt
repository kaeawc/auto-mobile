package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlin.math.max

/**
 * Network waterfall timeline chart. Each row shows a request with a horizontal bar
 * indicating its timing (start to end) relative to other requests.
 */
@Composable
fun NetworkWaterfall(
    events: List<TelemetryDisplayEvent.Network>,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val textColor = colors.text.normal

    val timeline = remember(events) {
        if (events.isEmpty()) return@remember WaterfallTimeline(0L, 0L, emptyList())
        val minTs = events.minOf { it.timestamp }
        val maxTs = events.maxOf { it.timestamp + it.durationMs }
        val totalDuration = max(maxTs - minTs, 1L)
        val rows = events.map { event ->
            WaterfallRow(
                label = "${event.method} ${event.path ?: event.url}",
                statusCode = event.statusCode,
                startFraction = (event.timestamp - minTs).toFloat() / totalDuration,
                widthFraction = max(event.durationMs.toFloat() / totalDuration, 0.005f),
                durationMs = event.durationMs,
                error = event.error,
            )
        }
        WaterfallTimeline(minTs, maxTs, rows)
    }

    if (events.isEmpty()) {
        Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No network events", fontSize = 12.sp, color = textColor.copy(alpha = 0.4f))
        }
        return
    }

    Column(modifier = modifier.fillMaxSize()) {
        // Time axis header
        TimeAxisHeader(timeline, textColor)

        // Request rows
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(timeline.rows) { row ->
                WaterfallRowView(row, textColor)
            }
        }
    }
}

@Composable
private fun TimeAxisHeader(timeline: WaterfallTimeline, textColor: Color) {
    val totalMs = timeline.maxTs - timeline.minTs
    val tickCount = 5
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(textColor.copy(alpha = 0.03f))
            .padding(start = 160.dp, end = 8.dp, top = 2.dp, bottom = 2.dp),
    ) {
        for (i in 0..tickCount) {
            val ms = totalMs * i / tickCount
            val label = when {
                ms >= 1000 -> "${"%.1f".format(ms / 1000.0)}s"
                else -> "${ms}ms"
            }
            if (i > 0) Spacer(Modifier.weight(1f))
            Text(label, fontSize = 8.sp, fontFamily = FontFamily.Monospace, color = textColor.copy(alpha = 0.4f))
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(textColor.copy(alpha = 0.08f)))
}

@Composable
private fun WaterfallRowView(row: WaterfallRow, textColor: Color) {
    val barColor = waterfallBarColor(row.statusCode, row.error)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Label column (fixed width)
        Box(
            modifier = Modifier
                .width(152.dp)
                .padding(start = 4.dp, end = 4.dp),
        ) {
            Text(
                row.label,
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                color = textColor.copy(alpha = 0.7f),
                maxLines = 1,
            )
        }

        // Waterfall bar
        Canvas(
            modifier = Modifier
                .weight(1f)
                .height(16.dp)
                .padding(end = 8.dp),
        ) {
            val canvasWidth = size.width
            val canvasHeight = size.height
            val barLeft = row.startFraction * canvasWidth
            val barW = row.widthFraction * canvasWidth

            // Background guideline
            drawLine(
                color = textColor.copy(alpha = 0.05f),
                start = Offset(0f, canvasHeight / 2),
                end = Offset(canvasWidth, canvasHeight / 2),
                strokeWidth = 1f,
            )

            // Request bar
            drawRoundRect(
                color = barColor,
                topLeft = Offset(barLeft, 2f),
                size = Size(barW.coerceAtLeast(2f), canvasHeight - 4f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f, 2f),
            )
        }

        // Duration label
        Text(
            "${row.durationMs}ms",
            fontSize = 9.sp,
            fontFamily = FontFamily.Monospace,
            color = textColor.copy(alpha = 0.5f),
            modifier = Modifier.width(50.dp),
        )
    }
}

private fun waterfallBarColor(statusCode: Int, error: String?): Color =
    networkStatusColor(statusCode, error, Color(0xFF74C0FC))

private data class WaterfallTimeline(
    val minTs: Long,
    val maxTs: Long,
    val rows: List<WaterfallRow>,
)

private data class WaterfallRow(
    val label: String,
    val statusCode: Int,
    val startFraction: Float,
    val widthFraction: Float,
    val durationMs: Long,
    val error: String?,
)
