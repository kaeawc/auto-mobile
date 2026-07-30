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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** A single command in the palette: a stable [id], a display [label], and its [run] action. */
data class PaletteCommand(val id: String, val label: String, val run: () -> Unit)

/** Commands matching [query] by case-insensitive substring; blank query returns all. Pure. */
internal fun filterCommands(commands: List<PaletteCommand>, query: String): List<PaletteCommand> {
  val q = query.trim()
  return if (q.isEmpty()) commands else commands.filter { it.label.contains(q, ignoreCase = true) }
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
  content.columns.forEach { column ->
    add(
      PaletteCommand("focus-${column.deviceId}", "Focus ${column.name}") {
        onAction(WorkspaceAction.FocusDevice(column.deviceId))
      }
    )
    add(
      PaletteCommand("close-${column.deviceId}", "Close ${column.name}") {
        onAction(WorkspaceAction.CloseDevice(column.deviceId))
      }
    )
  }
  val focused = content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }
  if (focused != null) {
    Tool.entries.forEach { tool ->
      add(
        PaletteCommand("tool-${tool.name}", "Open ${tool.label} on ${focused.name}") {
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
 */
@Composable
fun CommandPalette(
  commands: List<PaletteCommand>,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var query by remember { mutableStateOf("") }
  val results = filterCommands(commands, query)
  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(Color.Black.copy(alpha = 0.5f))
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
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Command search" },
      )
      Spacer(Modifier.height(8.dp))
      LazyColumn(Modifier.heightIn(max = 360.dp)) {
        items(results, key = { it.id }) { command ->
          Text(
            command.label,
            modifier =
              Modifier.fillMaxWidth()
                .clickable {
                  command.run()
                  onDismiss()
                }
                .padding(vertical = 8.dp, horizontal = 4.dp),
          )
        }
      }
    }
  }
}
