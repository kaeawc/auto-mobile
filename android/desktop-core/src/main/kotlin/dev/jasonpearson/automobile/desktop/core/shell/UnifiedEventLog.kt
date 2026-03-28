package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Scrollable event list for the center pane. Each row shows timestamp, category icon,
 * one-line summary, and duration/status badge. Clicking a row invokes [onEventSelected]
 * (detail rendering is delegated to the right inspector pane).
 */
@Composable
fun UnifiedEventLog(
    events: List<TelemetryDisplayEvent>,
    filterState: TelemetryFilterState,
    selectedEvent: TelemetryDisplayEvent?,
    onEventSelected: (TelemetryDisplayEvent?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors
    val listState = rememberLazyListState()
    val timeFormat = remember { SimpleDateFormat("HH:mm:ss.SSS", Locale.US) }
    var autoScrollEnabled by remember { mutableStateOf(true) }

    LaunchedEffect(listState.isScrollInProgress) {
        if (listState.isScrollInProgress) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val totalItems = listState.layoutInfo.totalItemsCount
            autoScrollEnabled = totalItems - lastVisible <= 3
        }
    }

    LaunchedEffect(events.size) {
        if (autoScrollEnabled && !filterState.isPaused && events.isNotEmpty()) {
            listState.animateScrollToItem(events.size - 1)
        }
    }

    if (events.isEmpty()) {
        Box(
            modifier = modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "No telemetry events",
                fontSize = 12.sp,
                color = colors.text.normal.copy(alpha = 0.4f),
            )
        }
    } else {
        LazyColumn(
            state = listState,
            modifier = modifier.fillMaxSize(),
        ) {
            items(events, key = { "${it.timestamp}_${System.identityHashCode(it)}" }) { event ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(
                            if (event == selectedEvent) {
                                Modifier.background(colors.text.normal.copy(alpha = 0.08f))
                            } else {
                                Modifier
                            }
                        )
                        .clickable { onEventSelected(if (selectedEvent == event) null else event) }
                        .pointerHoverIcon(PointerIcon.Hand)
                ) {
                    EventRow(event, timeFormat, colors.text.normal)
                }
            }
        }
    }
}

@Composable
private fun EventRow(
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
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            formattedTime,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            color = textColor.copy(alpha = 0.5f),
            maxLines = 1,
        )
        Text(categoryIcon(event), fontSize = 11.sp)
        Text(
            eventSummary(event),
            fontSize = 12.sp,
            color = summaryColor(event, textColor),
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        val badge = eventBadge(event)
        if (badge != null) {
            Box(
                modifier = Modifier
                    .background(badge.second.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(
                    badge.first,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                    color = badge.second,
                )
            }
        }
    }
}

private fun categoryIcon(event: TelemetryDisplayEvent): String = when (event) {
    is TelemetryDisplayEvent.Network -> "\uD83C\uDF10"           // 🌐
    is TelemetryDisplayEvent.Navigation -> "\uD83E\uDDED"        // 🧭
    is TelemetryDisplayEvent.Log -> "\uD83D\uDCDD"               // 📝
    is TelemetryDisplayEvent.Os -> "\u2699\uFE0F"                // ⚙️
    is TelemetryDisplayEvent.Custom -> "\uD83C\uDFF7\uFE0F"     // 🏷️
    is TelemetryDisplayEvent.Failure -> when (event.type) {
        "crash" -> "\uD83D\uDCA5"    // 💥
        "anr" -> "\u231B"            // ⌛
        else -> "\u26A0\uFE0F"       // ⚠️
    }
    is TelemetryDisplayEvent.Storage -> "\uD83D\uDDC4\uFE0F"    // 🗄️
    is TelemetryDisplayEvent.Layout -> "\uD83C\uDFD7\uFE0F"     // 🏗️
    is TelemetryDisplayEvent.Performance -> "\uD83D\uDCCA"       // 📊
    is TelemetryDisplayEvent.Memory -> "\uD83E\uDDE0"            // 🧠
    is TelemetryDisplayEvent.ToolCall -> "\uD83D\uDD27"          // 🔧
    is TelemetryDisplayEvent.Accessibility -> "\u267F"           // ♿
}

private fun eventSummary(event: TelemetryDisplayEvent): String = when (event) {
    is TelemetryDisplayEvent.Network -> {
        val path = event.path ?: event.url
        "${event.method} ${event.statusCode} $path"
    }
    is TelemetryDisplayEvent.Navigation -> event.destination
    is TelemetryDisplayEvent.Log -> "[${event.tag}] ${event.message}"
    is TelemetryDisplayEvent.Os -> "${event.category}: ${event.kind}"
    is TelemetryDisplayEvent.Custom -> event.name
    is TelemetryDisplayEvent.Failure -> "${event.type}: ${event.title}"
    is TelemetryDisplayEvent.Storage -> "${event.changeType} ${event.fileName}${event.key?.let { " [$it]" } ?: ""}"
    is TelemetryDisplayEvent.Layout -> "${event.subType}${event.composableName?.let { " ($it)" } ?: ""}"
    is TelemetryDisplayEvent.Performance -> "health=${event.health} ${event.changedMetrics.joinToString()}"
    is TelemetryDisplayEvent.Memory -> "${event.packageName} ${if (event.passed) "OK" else "LEAK"}"
    is TelemetryDisplayEvent.ToolCall -> event.toolName
    is TelemetryDisplayEvent.Accessibility -> "${event.packageName} ${event.totalViolations} violations"
}

private fun summaryColor(event: TelemetryDisplayEvent, textColor: Color): Color = when (event) {
    is TelemetryDisplayEvent.Network -> when {
        event.error != null || event.statusCode == 0 -> Color(0xFFFF6B6B)
        event.statusCode in 200..299 -> Color(0xFF51CF66)
        event.statusCode >= 400 -> Color(0xFFFF6B6B)
        else -> textColor.copy(alpha = 0.85f)
    }
    is TelemetryDisplayEvent.Failure -> Color(0xFFFF6B6B)
    is TelemetryDisplayEvent.Log -> when (event.level) {
        6, 7 -> Color(0xFFFF6B6B)
        5 -> Color(0xFFE0C040)
        else -> textColor.copy(alpha = 0.85f)
    }
    is TelemetryDisplayEvent.Memory -> if (!event.passed) Color(0xFFFF6B6B) else textColor.copy(alpha = 0.85f)
    else -> textColor.copy(alpha = 0.85f)
}

/**
 * Returns a (label, color) pair for the badge, or null if no badge is needed.
 */
private fun eventBadge(event: TelemetryDisplayEvent): Pair<String, Color>? = when (event) {
    is TelemetryDisplayEvent.Network -> "${event.durationMs}ms" to Color(0xFF74C0FC)
    is TelemetryDisplayEvent.ToolCall -> {
        val label = "${event.durationMs}ms"
        val color = if (event.success) Color(0xFF51CF66) else Color(0xFFFF6B6B)
        label to color
    }
    is TelemetryDisplayEvent.Failure -> event.severity.uppercase() to Color(0xFFFF6B6B)
    is TelemetryDisplayEvent.Layout -> event.durationMs?.let { "${it}ms" to Color(0xFF74C0FC) }
    is TelemetryDisplayEvent.Performance -> event.health.uppercase() to when (event.health) {
        "critical" -> Color(0xFFFF6B6B)
        "warning" -> Color(0xFFE0C040)
        else -> Color(0xFF51CF66)
    }
    else -> null
}
