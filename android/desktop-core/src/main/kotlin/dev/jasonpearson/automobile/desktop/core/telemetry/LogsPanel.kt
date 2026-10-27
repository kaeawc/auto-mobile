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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.components.SearchBarOptions
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.filter
import kotlinx.serialization.Serializable

/**
 * Exact Android logcat tags emitted by CtrlProxy itself, hidden by default to expose app logs.
 * `MainActivity` is deliberately excluded because it is also a common app tag. Consequently,
 * CtrlProxy's own `MainActivity` rows show by default alongside app rows; fixing that trade-off
 * requires package or process identity on [TelemetryDisplayEvent.Log], which is out of scope here.
 */
val AUTO_MOBILE_INTERNAL_TAGS: Set<String> =
  setOf(
    "ViewHierarchyExtractor",
    "WebSocketServer",
    "LogcatReader",
    "ServiceScopeGuard",
    "OverlayManager",
    "OverlayDrawer",
    "HighlightOverlayView",
    "InstalledPkgLaunch",
    "HierarchyDebouncer",
    "PermissionManager",
    "AsyncActionRunner",
    "CtrlProxy",
    "AutoMobileDeviceAdmin",
    "ResultBroadcaster",
    "StorageSubscriptionMgr",
    "PerfProvider",
  )

/**
 * A log severity bucket surfaced as an always-on filter chip. Android's raw priority ints
 * (`Log.VERBOSE`=2 .. `Log.ASSERT`=7) collapse into these five canonical buckets via [logLevelOf];
 * [color] mirrors the palette used by the telemetry dashboard's log summaries.
 */
@Serializable
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
 * Upper bound on retained live log rows. A high-volume device can stream logs indefinitely; without
 * a cap the buffer — and the per-append [filterLogs] cost over it — would grow until the UI stalls.
 */
const val MAX_LOG_ROWS = 5000

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
 *
 * [onFollowTailChange] observes tail-follow intent transitions (true = chasing the newest row). It
 * is an observation seam — tests assert the intent clears on the first user upward-scroll delta
 * rather than only when the scroll settles — and stays a no-op for real callers.
 */
@Composable
fun LogsPanel(
  telemetryPushClient: TelemetryPushClient?,
  settingsProvider: SettingsProvider = LocalAutoMobileGraph.current.settingsProvider,
  modifier: Modifier = Modifier,
  options: LogsPanelOptions = LogsPanelOptions(),
) {
  return with(options) {
    val colors = SharedTheme.globalColors
    val panel = rememberLogsPanelState(activeDeviceId, settingsProvider)
    with(panel) {
      // Keyed on `platform` (new scale) and `activeDeviceId` (a device switch swaps `logs` for a
      // fresh
      // remembered list, so the derived state must re-capture it — otherwise it keeps reading the
      // old
      // device's buffer). `enabledLevels` and `query` are Compose State reads that derivedStateOf
      // tracks on its own, so they are intentionally not remember keys.
      val filteredState =
        remember(platform, activeDeviceId) {
          derivedStateOf {
            filterLogs(
              logs = logs,
              options =
                LogFilter(
                  enabledLevels = enabledLevels,
                  query = query,
                  platform = platform,
                  tag = tag,
                  showInternalTags = showInternalTags,
                ),
            )
          }
        }
      // Per-device scroll state: recreated on a device switch so a device left scrolled up does not
      // carry its scroll offset (and suppress auto-follow) into the next device.
      val resolvedListState = listState ?: remember(activeDeviceId) { LazyListState() }

      // Clear follow intent on the first user upward-scroll delta (see [clearsTailFollow]), so a
      // row
      // arriving mid-fling no longer yanks the viewport back to the tail. The settle observer below
      // re-arms it once the user returns to the bottom. Remembered per device, like [listState].
      val tailFollowScrollConnection =
        remember(activeDeviceId) {
          object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
              if (clearsTailFollow(available, source)) followTail = false
              return Offset.Zero
            }
          }
        }

      CollectLogEvents(panel, telemetryPushClient)
      FollowLogTail(panel, telemetryPushClient, resolvedListState, filteredState)
      val statusText = connectionState?.let { connectionStatusText(it) }

      Column(modifier = modifier.fillMaxSize()) {
        PanelFilters(panel, settingsProvider)

        if (statusText != null) {
          Row(
            modifier =
              Modifier.fillMaxWidth()
                .background(Color(0xFF5C4033).copy(alpha = 0.3f))
                .padding(horizontal = 8.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(statusText, fontSize = 10.sp, color = Color(0xFFE0A040))
            if (connectionState is ConnectionState.Error && telemetryPushClient != null) {
              TextButton(onClick = { telemetryPushClient.connect(activeDeviceId) }) {
                Text("Retry")
              }
            }
          }
        }

        LogRows(panel, filteredState, resolvedListState, tailFollowScrollConnection, statusText)
      }
    }
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

data class LogsPanelOptions(
  val activeDeviceId: String? = null,
  val platform: LogPlatform = LogPlatform.Android,
  val maxRows: Int = MAX_LOG_ROWS,
  val listState: LazyListState? = null,
  val onFollowTailChange: (Boolean) -> Unit = {},
)

internal data class LogsFilterActions(
  val onQueryChange: (String) -> Unit,
  val onTagChange: (String) -> Unit,
  val onToggleLevel: (LogLevel) -> Unit,
  val onToggleInternalTags: () -> Unit,
  val savedViews: List<LogsSavedView>,
  val onOpenViews: () -> Unit,
  val onSaveView: (String) -> Unit,
  val onApplyView: (LogsSavedView) -> Unit,
  val onDeleteView: (LogsSavedView) -> Unit,
)

data class LogFilter(
  val enabledLevels: Set<LogLevel>,
  val query: String,
  val platform: LogPlatform = LogPlatform.Android,
  val tag: String? = null,
  val showInternalTags: Boolean = true,
)

internal data class LogsPanelState(
  val logs: androidx.compose.runtime.snapshots.SnapshotStateList<TelemetryDisplayEvent.Log>,
  val timeFormat: SimpleDateFormat,
  private val selectedEventState: androidx.compose.runtime.MutableState<TelemetryDisplayEvent.Log?>,
  private val queryState: androidx.compose.runtime.MutableState<String>,
  private val tagState: androidx.compose.runtime.MutableState<String>,
  private val enabledLevelsState: androidx.compose.runtime.MutableState<Set<LogLevel>>,
  private val showInternalTagsState: androidx.compose.runtime.MutableState<Boolean>,
  private val savedViewsState: androidx.compose.runtime.MutableState<List<LogsSavedView>>,
  private val connectionStateState: androidx.compose.runtime.MutableState<ConnectionState?>,
  private val appendCountState: androidx.compose.runtime.MutableState<Int>,
  private val followTailState: androidx.compose.runtime.MutableState<Boolean>,
) {
  var selectedEvent by selectedEventState
  var query by queryState
  var tag by tagState
  var enabledLevels by enabledLevelsState
  var showInternalTags by showInternalTagsState
  var savedViews by savedViewsState
  var connectionState by connectionStateState
  var appendCount by appendCountState
  var followTail by followTailState
}

@Composable
private fun rememberLogsPanelState(
  activeDeviceId: String?,
  settingsProvider: SettingsProvider,
): LogsPanelState =
  LogsPanelState(
    logs = remember(activeDeviceId) { mutableStateListOf<TelemetryDisplayEvent.Log>() },
    timeFormat = remember { SimpleDateFormat("HH:mm:ss.SSS", Locale.US) },
    selectedEventState =
      remember(activeDeviceId) { mutableStateOf<TelemetryDisplayEvent.Log?>(null) },
    queryState = remember { mutableStateOf("") },
    tagState = remember { mutableStateOf("") },
    enabledLevelsState =
      remember(activeDeviceId) {
        val savedLevels = activeDeviceId?.let { deviceId ->
          deserializeLogsEnabledLevelsByDevice(settingsProvider.logsEnabledLevelsByDevice)[deviceId]
        }
        val minimum =
          if (savedLevels == null) {
            activeDeviceId?.let { deviceId ->
              deserializeLogsMinLevelByDevice(settingsProvider.logsMinLevelByDevice)[deviceId]
                ?.let { name ->
                  LogLevel.entries.firstOrNull { it.name == name }
                }
            }
          } else {
            null
          }
        mutableStateOf(savedLevels ?: defaultEnabledLevels(minimum))
      },
    showInternalTagsState = remember(activeDeviceId) { mutableStateOf(false) },
    savedViewsState =
      remember(settingsProvider) {
        mutableStateOf(deserializeLogsSavedViews(settingsProvider.logsSavedViews))
      },
    connectionStateState = remember(activeDeviceId) { mutableStateOf<ConnectionState?>(null) },
    appendCountState = remember(activeDeviceId) { mutableStateOf(0) },
    followTailState = remember(activeDeviceId) { mutableStateOf(true) },
  )

@Composable
private fun LogsPanelOptions.CollectLogEvents(
  panel: LogsPanelState,
  telemetryPushClient: TelemetryPushClient?,
) {
  with(panel) {
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
  }
}

@Composable
private fun LogsPanelOptions.FollowLogTail(
  panel: LogsPanelState,
  telemetryPushClient: TelemetryPushClient?,
  resolvedListState: LazyListState,
  filteredState: androidx.compose.runtime.State<List<TelemetryDisplayEvent.Log>>,
) {
  val filtered by filteredState
  with(panel) {
    // Keyed on activeDeviceId as well as the client: the client is recreated per device by the
    // facet (so identity already changes on switch), but keying on the device id too makes the
    // reset
    // explicit and re-seeds the remembered connectionState for the new device.
    LaunchedEffect(telemetryPushClient, activeDeviceId) {
      val client = telemetryPushClient ?: return@LaunchedEffect
      client.connectionState.collect { connectionState = it }
    }

    // Re-arm follow intent whenever a scroll settles: we follow iff the viewport now rests at the
    // bottom. Immediate clearing on a user upward scroll is handled by
    // [tailFollowScrollConnection];
    // this settle pass re-arms once the user returns to the bottom. Filter changes do not scroll,
    // so
    // they never clear the intent. Keyed on activeDeviceId so a device switch restarts the
    // observer.
    LaunchedEffect(resolvedListState, activeDeviceId) {
      snapshotFlow { resolvedListState.isScrollInProgress }
        .collect { inProgress ->
          if (!inProgress) followTail = !resolvedListState.canScrollForward
        }
    }

    // Surface follow-intent transitions to the caller (observation seam; see [onFollowTailChange]).
    LaunchedEffect(followTail) { onFollowTailChange(followTail) }

    // Keep one collector alive across appends: restarting a frame-waiting effect for every row can
    // starve tail-follow while rows arrive faster than frames. The append signal also changes when
    // the bounded buffer is full and its size and measured item count stay constant.
    LaunchedEffect(
      resolvedListState,
      activeDeviceId,
      query,
      tag,
      enabledLevels,
      showInternalTags,
      platform,
      followTail,
    ) {
      if (followTail) {
        snapshotFlow {
          Triple(appendCount, filtered.lastIndex, resolvedListState.layoutInfo.totalItemsCount)
        }
          .filter { (_, lastIndex, measuredCount) ->
            lastIndex >= 0 && measuredCount > lastIndex
          }
          .conflate()
          .collect {
            // LayoutInfo changes during measure; defer until the next frame to avoid a nested
            // measure. Read the tail after waiting so an append during this frame wait is included.
            withFrameNanos {}
            val lastIndex = filtered.lastIndex
            if (lastIndex >= 0) resolvedListState.scrollToItem(lastIndex)
          }
      }
    }
  }
}

@Composable
private fun LogsPanelOptions.PanelFilters(
  panel: LogsPanelState,
  settingsProvider: SettingsProvider,
) {
  with(panel) {
    LogsFilterBar(
      query = query,
      tag = tag,
      enabledLevels = enabledLevels,
      showInternalTags = showInternalTags,
      options =
        LogsFilterActions(
          onQueryChange = { query = it },
          onTagChange = { tag = it },
          onToggleLevel = { level ->
            enabledLevels =
              if (level in enabledLevels) enabledLevels - level else enabledLevels + level
            if (activeDeviceId != null) {
              val byDevice =
                deserializeLogsEnabledLevelsByDevice(settingsProvider.logsEnabledLevelsByDevice)
                  .toMutableMap()
              byDevice[activeDeviceId] = enabledLevels
              settingsProvider.logsEnabledLevelsByDevice =
                serializeLogsEnabledLevelsByDevice(byDevice)
            }
          },
          onToggleInternalTags = { showInternalTags = !showInternalTags },
          savedViews = savedViews,
          onOpenViews = {
            savedViews = deserializeLogsSavedViews(settingsProvider.logsSavedViews)
          },
          onSaveView = { name ->
            val view = LogsSavedView(name, enabledLevels, tag.ifBlank { null }, query)
            savedViews =
              mutateLogsSavedViews(settingsProvider) { current ->
                current.filterNot { it.name == name } + view
              }
          },
          onApplyView = { view ->
            enabledLevels = view.enabledLevels
            tag = view.tag.orEmpty()
            query = view.query
          },
          onDeleteView = { view ->
            savedViews =
              mutateLogsSavedViews(settingsProvider) { current ->
                current.filterNot { it.name == view.name }
              }
          },
        ),
    )
  }
}

@Composable
private fun LogsPanelOptions.LogRows(
  panel: LogsPanelState,
  filteredState: androidx.compose.runtime.State<List<TelemetryDisplayEvent.Log>>,
  resolvedListState: LazyListState,
  tailFollowScrollConnection: NestedScrollConnection,
  statusText: String?,
) {
  val filtered by filteredState
  val colors = SharedTheme.globalColors
  with(panel) {
    if (filtered.isEmpty()) {
      Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val message =
          when {
            // A non-healthy socket is why there are no rows — say so instead of the misleading
            // "No logs yet" (which implies a healthy but quiet stream).
            statusText != null -> statusText
            query.isBlank() && tag.isBlank() && enabledLevels == defaultEnabledLevels(null) ->
              "No logs yet"
            else -> "No logs match the filter"
          }
        Text(message, fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.4f))
      }
    } else {
      LazyColumn(
        state = resolvedListState,
        modifier = Modifier.fillMaxSize().nestedScroll(tailFollowScrollConnection),
      ) {
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

@Composable
internal fun LogsFilterActions.SavedViewsMenu(menu: LogsMenuState) {
  with(menu) {
    Box {
      TextButton(
        onClick = {
          onOpenViews()
          viewsOpen = true
        },
      ) {
        Text("Saved views", fontSize = 11.sp)
      }
      DropdownMenu(expanded = viewsOpen, onDismissRequest = { viewsOpen = false }) {
        DropdownMenuItem(
          text = { Text("Save current view…") },
          onClick = { namingView = true },
        )
        if (namingView) {
          Row(
            modifier = Modifier.width(240.dp).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            SearchBar(
              query = viewName,
              onQueryChange = { viewName = it },
              modifier = Modifier.weight(1f).semantics { contentDescription = "Saved view name" },
              options = SearchBarOptions(placeholder = "View name"),
            )
            TextButton(
              enabled = viewName.isNotBlank(),
              onClick = {
                onSaveView(viewName.trim())
                viewName = ""
                namingView = false
                viewsOpen = false
              },
            ) {
              Text("Save")
            }
          }
        }
        SavedViewItems(menu)
      }
    }
  }
}

internal class LogsMenuState {
  var viewsOpen by mutableStateOf(false)
  var namingView by mutableStateOf(false)
  var viewName by mutableStateOf("")
}

@Composable
private fun LogsFilterActions.SavedViewItems(menu: LogsMenuState) {
  with(menu) {
    savedViews.forEach { view ->
      DropdownMenuItem(
        text = { Text(view.name) },
        onClick = {
          onApplyView(view)
          viewsOpen = false
        },
        trailingIcon = {
          TextButton(
            onClick = { onDeleteView(view) },
            modifier = Modifier.semantics { contentDescription = "Delete view ${view.name}" },
          ) {
            Text("Delete", fontSize = 10.sp)
          }
        },
      )
    }
  }
}
