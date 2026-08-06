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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
 * Which platform's numeric log-priority scale a row's `level` field uses. A telemetry panel is
 * scoped to a single device, so every row it shows shares one scale — the caller supplies it rather
 * than the (platform-less) row carrying it. Android and iOS number their levels differently, so the
 * same int means different severities on each.
 */
enum class LogPlatform {
  Android,
  Ios,
}

/**
 * Maps a raw log-priority int to its [LogLevel] bucket for the given [platform]. Every int maps to
 * exactly one bucket so that "all chips enabled" is a true no-op filter.
 *
 * Android uses `Log.VERBOSE`=2 .. `Log.ASSERT`=7; iOS's `LogLevel` uses `verbose`=0 .. `fault`=5
 * (see `ios/auto-mobile-sdk/.../Events/SdkEvent.swift`). Both fold their top severities (Android
 * Assert, iOS Fault) into [Error], and unknown/low priorities into [Verbose].
 */
fun logLevelOf(level: Int, platform: LogPlatform = LogPlatform.Android): LogLevel =
  when (platform) {
    LogPlatform.Android ->
      when {
        level <= 2 -> LogLevel.Verbose
        level == 3 -> LogLevel.Debug
        level == 4 -> LogLevel.Info
        level == 5 -> LogLevel.Warn
        else -> LogLevel.Error
      }
    LogPlatform.Ios ->
      when {
        level <= 0 -> LogLevel.Verbose
        level == 1 -> LogLevel.Debug
        level == 2 -> LogLevel.Info
        level == 3 -> LogLevel.Warn
        else -> LogLevel.Error // 4 = error, 5 = fault
      }
  }

/**
 * Client-side filter over already-streamed log rows. A row survives when its [LogLevel] (bucketed
 * for [platform]) is in [enabledLevels] and its tag/message matches [query] (case-insensitive
 * substring). A blank [query] and the full level set together return the input unchanged, so an
 * untouched filter bar shows everything.
 */
fun filterLogs(
  logs: List<TelemetryDisplayEvent.Log>,
  enabledLevels: Set<LogLevel>,
  query: String,
  platform: LogPlatform = LogPlatform.Android,
): List<TelemetryDisplayEvent.Log> = logs.filter {
  logLevelOf(it.level, platform) in enabledLevels && it.matchesSearch(query)
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
 * Human-readable status for a non-healthy telemetry [ConnectionState], or `null` when
 * [ConnectionState.Connected] (nothing to surface). Pure so the mapping is unit-testable and the
 * panel never mislabels a connecting/errored socket as an empty-but-healthy stream.
 */
fun connectionStatusText(state: ConnectionState): String? =
  when (state) {
    is ConnectionState.Connecting -> "Connecting..."
    is ConnectionState.Reconnecting -> "Reconnecting (attempt ${state.attempt})..."
    is ConnectionState.Disconnected -> "Disconnected" + (state.reason?.let { ": $it" } ?: "")
    is ConnectionState.Error -> "Error: ${state.message}"
    is ConnectionState.Connected -> null
  }

/**
 * Logs facet body: a logs-only event stream with an always-on filter bar (per-level chips +
 * free-text search) applied client-side over the rows already received from [telemetryPushClient].
 * Filtering never touches the daemon protocol — it only narrows what is already in memory.
 *
 * The client is owned by the caller (the facet connects/disposes it per device). Streamed rows are
 * kept per [activeDeviceId] (capped at [maxRows]); switching devices clears the buffer. [platform]
 * selects the numeric log-level scale used to bucket rows into filter chips (see [logLevelOf]).
 *
 * Clicking a row selects it (highlight) and expands an inline detail surface directly beneath it —
 * the docked facet has no separate inspector pane, so this is where the full, single-line-truncated
 * message becomes reachable. Selection is held here in composition and keyed on [activeDeviceId],
 * so it is inherently pane-local (each pane composes its own [LogsPanel]) and clears on a device
 * switch.
 */
@Composable
fun LogsPanel(
  telemetryPushClient: TelemetryPushClient?,
  activeDeviceId: String? = null,
  platform: LogPlatform = LogPlatform.Android,
  maxRows: Int = MAX_LOG_ROWS,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val logs = remember(activeDeviceId) { mutableStateListOf<TelemetryDisplayEvent.Log>() }
  val timeFormat = remember { SimpleDateFormat("HH:mm:ss.SSS", Locale.US) }
  // Pane-local selected row; cleared on device switch (a switch also swaps the buffer for a fresh
  // list, so a stale selection could never re-match anyway). Holds the row instance for referential
  // identity — filterLogs preserves instances, so `===` stays valid across recompositions.
  var selectedEvent by remember(activeDeviceId) { mutableStateOf<TelemetryDisplayEvent.Log?>(null) }
  var query by remember { mutableStateOf("") }
  var enabledLevels by remember { mutableStateOf(LogLevel.entries.toSet()) }
  var connectionState by remember(activeDeviceId) { mutableStateOf<ConnectionState?>(null) }
  // Monotonic append counter: unlike filtered.size it keeps advancing once the buffer is pinned at
  // maxRows, so the tail-follow effect below still re-fires on every appended row at the cap.
  var appendCount by remember(activeDeviceId) { mutableStateOf(0) }
  // Tail-follow *intent*: preserved across filter changes and reset only when the user scrolls away
  // from the bottom, so clearing a filter that had anchored the list on an old row still follows
  // the next live row.
  var followTail by remember(activeDeviceId) { mutableStateOf(true) }

  // Keyed on `platform` (new scale) and `activeDeviceId` (a device switch swaps `logs` for a fresh
  // remembered list, so the derived state must re-capture it — otherwise it keeps reading the old
  // device's buffer). `enabledLevels` and `query` are Compose State reads that derivedStateOf
  // tracks on its own, so they are intentionally not remember keys.
  val filtered by
    remember(platform, activeDeviceId) {
      derivedStateOf { filterLogs(logs, enabledLevels, query, platform) }
    }
  // Per-device scroll state: recreated on a device switch so a device left scrolled up does not
  // carry its scroll offset (and suppress auto-follow) into the next device.
  val listState = remember(activeDeviceId) { LazyListState() }

  LaunchedEffect(telemetryPushClient, activeDeviceId, maxRows) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.telemetryEvents.collect { event ->
      if (event is TelemetryDisplayEvent.Log) {
        // The append can drop the oldest row (front) once the buffer is at its cap. If that
        // dropped row is the current selection, clear it — otherwise its highlight/detail vanish
        // from view while `selectedEvent` keeps a stale, now-invisible reference the user can no
        // longer toggle off. Steady-state eviction is a single front row (maxRows is fixed per
        // panel), so this O(1) identity check is enough.
        val evicted = if (logs.size >= maxRows) logs.firstOrNull() else null
        appendBounded(logs, event, maxRows)
        appendCount++
        if (evicted != null && evicted === selectedEvent) {
          selectedEvent = null
        }
      }
    }
  }

  // Keyed on activeDeviceId as well as the client: the client is recreated per device by the
  // facet (so identity already changes on switch), but keying on the device id too makes the reset
  // explicit and re-seeds the remembered connectionState for the new device.
  LaunchedEffect(telemetryPushClient, activeDeviceId) {
    val client = telemetryPushClient ?: return@LaunchedEffect
    client.connectionState.collect { connectionState = it }
  }

  // Re-derive follow intent whenever a scroll settles: we follow iff the viewport rests at the
  // bottom. A user drag that stops mid-list clears it; reaching the bottom (or a programmatic
  // tail scroll) re-arms it. Filter changes do not scroll, so they never clear the intent. Keyed
  // on activeDeviceId so a device switch restarts the observer against the reset follow state.
  LaunchedEffect(listState, activeDeviceId) {
    snapshotFlow { listState.isScrollInProgress }
      .collect { inProgress -> if (!inProgress) followTail = !listState.canScrollForward }
  }

  // Follow the tail when following: fires on every appended row (via appendCount, which advances
  // even at the buffer cap) and on filter/platform changes (which re-anchor the list), so the
  // newest visible row stays in view without fighting a scrolled-up user.
  LaunchedEffect(appendCount, query, enabledLevels, platform, followTail) {
    if (followTail && filtered.isNotEmpty()) {
      listState.scrollToItem(filtered.lastIndex)
    }
  }

  val statusText = connectionState?.let { connectionStatusText(it) }

  Column(modifier = modifier.fillMaxSize()) {
    LogsFilterBar(
      query = query,
      onQueryChange = { query = it },
      enabledLevels = enabledLevels,
      onToggleLevel = { level ->
        enabledLevels = if (level in enabledLevels) enabledLevels - level else enabledLevels + level
      },
    )

    if (statusText != null) {
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .background(Color(0xFF5C4033).copy(alpha = 0.3f))
            .padding(horizontal = 8.dp, vertical = 2.dp)
      ) {
        Text(statusText, fontSize = 10.sp, color = Color(0xFFE0A040))
      }
    }

    if (filtered.isEmpty()) {
      Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val message =
          when {
            // A non-healthy socket is why there are no rows — say so instead of the misleading
            // "No logs yet" (which implies a healthy but quiet stream).
            statusText != null -> statusText
            query.isBlank() && enabledLevels == LogLevel.entries.toSet() -> "No logs yet"
            else -> "No logs match the filter"
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
          val event = filtered[index]
          val isSelected = event === selectedEvent
          Column {
            LogRow(
              event = event,
              textColor = colors.text.normal,
              platform = platform,
              isSelected = isSelected,
              onClick = { selectedEvent = if (isSelected) null else event },
            )
            if (isSelected) {
              LogEventDetail(event, colors.text.normal, platform, timeFormat)
            }
          }
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

/**
 * Single log row: level letter, tag, and message, matching the dashboard's compact styling. The
 * whole row is a clickable, selectable node — clicking it toggles selection; [isSelected] adds a
 * highlight background and the `selected` semantics that assistive tech (and tests) read.
 */
@Composable
private fun LogRow(
  event: TelemetryDisplayEvent.Log,
  textColor: Color,
  platform: LogPlatform,
  isSelected: Boolean,
  onClick: () -> Unit,
) {
  val level = logLevelOf(event.level, platform)
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .then(if (isSelected) Modifier.background(textColor.copy(alpha = 0.08f)) else Modifier)
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .semantics {
          // Announce the row as an activatable target whose on/off selection state is spoken,
          // rather than a bare unlabeled node — a step up from the legacy selectable row, which
          // emitted no `selected` semantics at all.
          selected = isSelected
          role = Role.Button
        }
        .padding(horizontal = 8.dp, vertical = 2.dp),
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
    // Bound the tag so a long tag can't consume the whole row and starve the message of width.
    Text(
      event.tag,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.6f),
      maxLines = 1,
      modifier = Modifier.widthIn(max = 140.dp),
    )
    Spacer(Modifier.width(6.dp))
    // Message takes the remaining width and stays a single compact line (like the replaced
    // dashboard): keeps every row a uniform height so tail-follow's scrollToItem lands on the
    // true bottom instead of a tall wrapped row that leaves canScrollForward true.
    Text(
      event.message,
      fontSize = 11.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.9f),
      maxLines = 1,
      modifier = Modifier.weight(1f),
    )
  }
}

/**
 * Inline detail surface for the selected log row, rendered directly beneath it. The compact
 * single-line [LogRow] truncates the message and the docked facet has no separate inspector pane,
 * so this is where the row's full content becomes reachable: the timestamp/level/tag header plus
 * the complete, wrapping message in a [SelectionContainer] so it can be selected and copied.
 */
@Composable
private fun LogEventDetail(
  event: TelemetryDisplayEvent.Log,
  textColor: Color,
  platform: LogPlatform,
  timeFormat: SimpleDateFormat,
) {
  val level = logLevelOf(event.level, platform)
  val formattedTime = remember(event.timestamp) { timeFormat.format(Date(event.timestamp)) }
  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.04f))
        .padding(horizontal = 12.dp, vertical = 8.dp)
        .semantics { contentDescription = "Log event detail" },
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Text(
      "$formattedTime  ${level.label}  ${event.tag}",
      fontSize = 10.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.6f),
    )
    SelectionContainer {
      Text(
        event.message,
        fontSize = 11.sp,
        fontFamily = FontFamily.Monospace,
        color = textColor.copy(alpha = 0.9f),
      )
    }
  }
}
