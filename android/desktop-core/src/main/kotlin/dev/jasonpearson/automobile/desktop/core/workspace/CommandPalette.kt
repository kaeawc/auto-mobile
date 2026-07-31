package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** A single command in the palette: a stable [id], a display [label], and its [run] action. */
data class PaletteCommand(val id: String, val label: String, val run: () -> Unit)

/**
 * True when a key event should open the command palette: the "K" key together with the platform
 * accelerator modifier — Meta (⌘) on macOS or Ctrl elsewhere. Accepting either modifier keeps this
 * platform-agnostic (⌘K and Ctrl+K both match) without needing to know the host OS here. Any other
 * key, or "K" with no accelerator, returns false so the event propagates normally.
 *
 * Pure over its inputs so the window-level key binding stays thin, testable glue.
 */
fun isCommandPaletteShortcut(key: Key, isMetaPressed: Boolean, isCtrlPressed: Boolean): Boolean =
  key == Key.K && (isMetaPressed || isCtrlPressed)

/** Commands matching [query] by case-insensitive substring; blank query returns all. Pure. */
internal fun filterCommands(commands: List<PaletteCommand>, query: String): List<PaletteCommand> {
  val q = query.trim()
  return if (q.isEmpty()) commands else commands.filter { it.label.contains(q, ignoreCase = true) }
}

/**
 * Human-readable display names for [columns], keyed by device id. When two columns share a display
 * name (common for iOS simulators, which surface identical labels like "iPhone 15"), the colliding
 * ones get a device-id suffix so palette labels stay distinguishable. The suffix is the *shortest*
 * length that is unique within that duplicate-name group, so devices whose ids share a final run of
 * characters still get labels that differ. Unique names are left untouched. Command ids are already
 * device-id-keyed, so this only affects the visible label. Pure.
 */
internal fun disambiguatedDeviceNames(columns: List<DeviceColumn>): Map<String, String> = buildMap {
  columns
    .groupBy { it.name }
    .forEach { (name, group) ->
      if (group.size == 1) {
        put(group.single().deviceId, name)
      } else {
        val length = shortestDistinguishingLength(group.map { it.deviceId })
        group.forEach { column ->
          put(column.deviceId, "$name (${column.deviceId.takeLast(length)})")
        }
      }
    }
}

/**
 * The shortest id-suffix length whose `takeLast` values are all distinct across [deviceIds], so a
 * duplicate-name group gets the minimal readable disambiguator. Falls back to the longest id length
 * (the full id) when no shorter suffix separates them.
 */
private fun shortestDistinguishingLength(deviceIds: List<String>): Int {
  val maxLength = deviceIds.maxOf { it.length }
  return (1..maxLength).firstOrNull { length ->
    deviceIds.mapTo(mutableSetOf()) { it.takeLast(length) }.size == deviceIds.size
  } ?: maxLength
}

/**
 * The commands available for the current workspace [state]: open the picker, focus/close each
 * observed device, open any tool on the focused device, and (with >1 device) compare the focused
 * device's active tool. Each command dispatches an existing workspace action, so the palette needs
 * no new backend. Pure over its inputs for testability.
 */
fun buildWorkspaceCommands(
  state: WorkspaceUiState,
  onOpenPicker: () -> Unit,
  onAction: (WorkspaceAction) -> Unit,
): List<PaletteCommand> = buildList {
  add(PaletteCommand("open-devices", "Open Devices", onOpenPicker))
  val content = state as? WorkspaceUiState.Content ?: return@buildList
  val displayNames = disambiguatedDeviceNames(content.columns)
  content.columns.forEach { column ->
    val name = displayNames[column.deviceId] ?: column.name
    add(
      PaletteCommand("focus-${column.deviceId}", "Focus $name") {
        onAction(WorkspaceAction.FocusDevice(column.deviceId))
      }
    )
    add(
      PaletteCommand("close-${column.deviceId}", "Close $name") {
        onAction(WorkspaceAction.CloseDevice(column.deviceId))
      }
    )
  }
  val focused = content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }
  if (focused != null) {
    val focusedName = displayNames[focused.deviceId] ?: focused.name
    Tool.entries.forEach { tool ->
      add(
        PaletteCommand("tool-${tool.name}", "Open ${tool.label} on $focusedName") {
          onAction(WorkspaceAction.SelectTool(focused.deviceId, tool))
        }
      )
    }
    if (content.columns.size > 1) {
      focused.activeTool?.let { active ->
        add(
          PaletteCommand("diff-${active.name}", "Compare ${active.label} across devices") {
            onAction(WorkspaceAction.DiffTool(active))
          }
        )
      }
    }
  }
}

/**
 * Quick-jump command palette (⌘K): a search field over a filtered command list, on a dimmed shell.
 * Selecting a command runs it and dismisses; clicking the scrim dismisses.
 *
 * Keyboard: Up/Down move a highlighted selection through the filtered results (wrapping at the
 * ends), Enter runs the highlighted command, and Esc dismisses. The handler is a *preview* handler
 * on the palette root so it sees keys before the focused search field, letting the arrows navigate
 * results rather than move the text cursor.
 */
@Composable
fun CommandPalette(
  commands: List<PaletteCommand>,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var query by remember { mutableStateOf("") }
  val results = filterCommands(commands, query)
  var selectedIndex by remember { mutableStateOf(0) }
  // A narrowing filter can leave the selection past the end of the shorter list; clamp it back into
  // range (or to 0 when empty) so Enter and the highlight never read out of bounds.
  val safeIndex = selectedIndex.coerceIn(0, (results.size - 1).coerceAtLeast(0))
  // Reset the highlight to the top whenever the filter changes the result set.
  LaunchedEffect(query) { selectedIndex = 0 }
  // Focus the search field as soon as the palette opens, so the user can type immediately.
  val searchFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { searchFocus.requestFocus() }
  val listState = rememberLazyListState()
  // Keep the highlighted row visible as the selection moves.
  LaunchedEffect(safeIndex, results.size) {
    if (results.isNotEmpty()) listState.animateScrollToItem(safeIndex)
  }
  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(Color.Black.copy(alpha = 0.5f))
        .onPreviewKeyEvent { event ->
          if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
          when (event.key) {
            Key.DirectionDown -> {
              if (results.isNotEmpty()) selectedIndex = (safeIndex + 1) % results.size
              true
            }
            Key.DirectionUp -> {
              if (results.isNotEmpty())
                selectedIndex = (safeIndex - 1 + results.size) % results.size
              true
            }
            Key.Enter,
            Key.NumPadEnter -> {
              results.getOrNull(safeIndex)?.let {
                it.run()
                onDismiss()
              }
              true
            }
            Key.Escape -> {
              onDismiss()
              true
            }
            else -> false
          }
        }
        .clickable(
          interactionSource = remember { MutableInteractionSource() },
          indication = null,
          onClick = onDismiss,
        )
        .semantics { contentDescription = "Command palette" },
    contentAlignment = Alignment.TopCenter,
  ) {
    Column(
      Modifier.padding(top = 80.dp)
        .widthIn(max = 560.dp)
        .fillMaxWidth(0.6f)
        .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
        // Swallow clicks so interacting with the card doesn't dismiss via the scrim.
        .clickable(
          interactionSource = remember { MutableInteractionSource() },
          indication = null,
          onClick = {},
        )
        .padding(12.dp)
    ) {
      OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        singleLine = true,
        label = { Text("Search commands") },
        modifier =
          Modifier.fillMaxWidth().focusRequester(searchFocus).semantics {
            contentDescription = "Command search"
          },
      )
      Spacer(Modifier.height(8.dp))
      LazyColumn(state = listState, modifier = Modifier.heightIn(max = 360.dp)) {
        itemsIndexed(results, key = { _, command -> command.id }) { index, command ->
          val isSelected = index == safeIndex
          val highlight =
            if (isSelected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent
          Text(
            command.label,
            modifier =
              Modifier.fillMaxWidth()
                .background(highlight)
                .clickable {
                  command.run()
                  onDismiss()
                }
                // Announce the keyboard highlight to assistive tech, not just visually.
                .semantics { selected = isSelected }
                .padding(vertical = 8.dp, horizontal = 4.dp),
          )
        }
      }
    }
  }
}
