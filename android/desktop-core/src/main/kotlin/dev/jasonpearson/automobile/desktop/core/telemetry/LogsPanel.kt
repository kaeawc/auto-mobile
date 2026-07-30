package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * A log severity bucket surfaced as an always-on filter chip. Android's raw priority ints
 * (`Log.VERBOSE`=2 .. `Log.ASSERT`=7) collapse into these five canonical buckets via [logLevelOf];
 * [color] mirrors the palette used by the telemetry dashboard's log summaries.
 */
enum class LogLevel(val label: String, val letter: String, val color: Long) {
  Verbose("Verbose", "V", 0xFF9E9E9E),
  Debug("Debug", "D", 0xFF74C0FC),
  Info("Info", "I", 0xFF51CF66),
  Warn("Warn", "W", 0xFFE0C040),
  Error("Error", "E", 0xFFE06060),
}

/**
 * Maps an Android log-priority int to its [LogLevel] bucket. Every int maps to exactly one bucket
 * so that "all chips enabled" is a true no-op filter: unknown/low priorities fall back to
 * [Verbose], and Assert (7) or higher folds into [Error].
 */
fun logLevelOf(level: Int): LogLevel =
  when {
    level <= 2 -> LogLevel.Verbose
    level == 3 -> LogLevel.Debug
    level == 4 -> LogLevel.Info
    level == 5 -> LogLevel.Warn
    else -> LogLevel.Error
  }

/**
 * Client-side filter over already-streamed log rows. A row survives when its [LogLevel] is in
 * [enabledLevels] and its tag/message matches [query] (case-insensitive substring). A blank [query]
 * and the full level set together return the input unchanged, so an untouched filter bar shows
 * everything.
 */
fun filterLogs(
  logs: List<TelemetryDisplayEvent.Log>,
  enabledLevels: Set<LogLevel>,
  query: String,
): List<TelemetryDisplayEvent.Log> = logs.filter {
  logLevelOf(it.level) in enabledLevels && it.matchesSearch(query)
}

/**
 * Logs facet body: a logs-only event stream with an always-on filter bar (per-level chips +
 * free-text search) applied client-side over the rows already received from [telemetryPushClient].
 * Filtering never touches the daemon protocol — it only narrows what is already in memory.
 *
 * The client is owned by the caller (the facet connects/disposes it per device). Streamed rows are
 * kept per [activeDeviceId]; switching devices clears the buffer.
 */
@Composable
fun LogsPanel(
  telemetryPushClient: TelemetryPushClient?,
  activeDeviceId: String? = null,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val logs = remember(activeDeviceId) { mutableStateListOf<TelemetryDisplayEvent.Log>() }
  var query by remember { mutableStateOf("") }
  var enabledLevels by remember { mutableStateOf(LogLevel.entries.toSet()) }

  LaunchedEffect(telemetryPushClient, activeDeviceId) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.telemetryEvents.collect { event ->
      if (event is TelemetryDisplayEvent.Log) logs.add(event)
    }
  }

  val filtered by remember {
    derivedStateOf { filterLogs(logs, enabledLevels, query) }
  }
  val listState = rememberLazyListState()

  Column(modifier = modifier.fillMaxSize()) {
    LogsFilterBar(
      query = query,
      onQueryChange = { query = it },
      enabledLevels = enabledLevels,
      onToggleLevel = { level ->
        enabledLevels = if (level in enabledLevels) enabledLevels - level else enabledLevels + level
      },
    )

    if (filtered.isEmpty()) {
      Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val message =
          if (query.isBlank() && enabledLevels == LogLevel.entries.toSet()) {
            "No logs yet"
          } else {
            "No logs match the filter"
          }
        Text(message, fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.4f))
      }
    } else {
      LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
        items(
          count = filtered.size,
          key = { index ->
            val event = filtered[index]
            "${event.timestamp}_${System.identityHashCode(event)}"
          },
        ) { index ->
          LogRow(filtered[index], colors.text.normal)
        }
      }
    }
  }
}

/** Always-on filter bar: a free-text search field plus one toggle chip per [LogLevel]. */
@Composable
private fun LogsFilterBar(
  query: String,
  onQueryChange: (String) -> Unit,
  enabledLevels: Set<LogLevel>,
  onToggleLevel: (LogLevel) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    SearchBar(
      query = query,
      onQueryChange = onQueryChange,
      placeholder = "Filter logs...",
      modifier = Modifier.weight(1f),
    )
    LogLevel.entries.forEach { level ->
      val isEnabled = level in enabledLevels
      Box(
        modifier =
          Modifier.background(
              if (isEnabled) Color(level.color).copy(alpha = 0.18f) else Color.Transparent,
              RoundedCornerShape(4.dp),
            )
            .clickable { onToggleLevel(level) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 6.dp, vertical = 4.dp)
            .clearAndSetSemantics { contentDescription = "Toggle ${level.label} logs" }
      ) {
        Text(
          level.letter,
          fontSize = 11.sp,
          fontFamily = FontFamily.Monospace,
          fontWeight = FontWeight.SemiBold,
          color =
            if (isEnabled) Color(level.color)
            else SharedTheme.globalColors.text.normal.copy(alpha = 0.35f),
        )
      }
    }
  }
}

/** Single log row: level letter, tag, and message, matching the dashboard's compact styling. */
@Composable
private fun LogRow(event: TelemetryDisplayEvent.Log, textColor: Color) {
  val level = logLevelOf(event.level)
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Text(
      level.letter,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      fontWeight = FontWeight.SemiBold,
      color = Color(level.color),
    )
    Spacer(Modifier.width(6.dp))
    Text(
      event.tag,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.6f),
      maxLines = 1,
    )
    Spacer(Modifier.width(6.dp))
    Text(
      event.message,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.9f),
    )
  }
}
