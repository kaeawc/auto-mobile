package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
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
 * Upper bound on retained live log rows. A high-volume device can stream logs indefinitely; without
 * a cap the buffer — and the per-append [filterLogs] cost over it — would grow until the UI stalls.
 */
const val MAX_LOG_ROWS = 5000

/**
 * Appends [event] to [logs] with ring-buffer semantics: once the buffer exceeds [max] the oldest
 * rows are dropped, so only the most recent [max] rows are retained. Kept pure (operates on any
 * [MutableList]) so the bound is unit-testable without Compose.
 */
fun appendBounded(
  logs: MutableList<TelemetryDisplayEvent.Log>,
  event: TelemetryDisplayEvent.Log,
  max: Int = MAX_LOG_ROWS,
) {
  logs.add(event)
  while (logs.size > max) {
    logs.removeAt(0)
  }
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

  val filtered by remember { derivedStateOf { filterLogs(logs, enabledLevels, query) } }
  val listState = rememberLazyListState()

  LaunchedEffect(telemetryPushClient, activeDeviceId) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.telemetryEvents.collect { event ->
      if (event is TelemetryDisplayEvent.Log) {
        // Sample tail-follow intent *before* the append shifts the layout: only keep following
        // when the viewport is already pinned to the bottom, so a user who scrolled up to read
        // history is never yanked back down.
        val wasAtBottom = !listState.canScrollForward
        appendBounded(logs, event)
        val rows = filtered
        if (wasAtBottom && rows.isNotEmpty()) {
          listState.scrollToItem(rows.lastIndex)
        }
      }
    }
  }

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

/**
 * Always-on filter bar: a full-width free-text search field over a horizontally-scrollable row of
 * per-[LogLevel] toggle chips. Keeping the chips on their own scrolling row means they can never
 * clip or squeeze the search field in a narrow device column — the search stays fully usable and
 * the overflowing chips scroll instead.
 */
@Composable
private fun LogsFilterBar(
  query: String,
  onQueryChange: (String) -> Unit,
  enabledLevels: Set<LogLevel>,
  onToggleLevel: (LogLevel) -> Unit,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    SearchBar(
      query = query,
      onQueryChange = onQueryChange,
      placeholder = "Filter logs...",
      modifier = Modifier.fillMaxWidth(),
    )
    Row(
      modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      LogLevel.entries.forEach { level ->
        LevelChip(
          level = level,
          isEnabled = level in enabledLevels,
          onToggle = { onToggleLevel(level) },
        )
      }
    }
  }
}

/** A single toggle chip for one [LogLevel], with switch-role selected semantics for a11y. */
@Composable
private fun LevelChip(level: LogLevel, isEnabled: Boolean, onToggle: () -> Unit) {
  Box(
    modifier =
      Modifier.background(
          if (isEnabled) Color(level.color).copy(alpha = 0.18f) else Color.Transparent,
          RoundedCornerShape(4.dp),
        )
        .clickable { onToggle() }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 6.dp, vertical = 4.dp)
        .clearAndSetSemantics {
          // Stable label so tests/AT can find the chip, plus role + selected/state so its on/off
          // state is announced rather than a bare static "Toggle …" label.
          contentDescription = "Toggle ${level.label} logs"
          stateDescription = if (isEnabled) "Shown" else "Hidden"
          selected = isEnabled
          role = Role.Switch
        }
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
