package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** A single command that can be executed from the command palette. */
data class Command(
  val id: String,
  val label: String,
  val shortcut: String,
  val action: () -> Unit,
)

/** Registry holding all available commands for the command palette. */
class CommandRegistry {
  private val commands = mutableListOf<Command>()

  fun register(command: Command) {
    commands.add(command)
  }

  fun registerAll(newCommands: List<Command>) {
    commands.addAll(newCommands)
  }

  fun clear() {
    commands.clear()
  }

  fun allCommands(): List<Command> = commands.toList()

  fun search(query: String): List<Command> {
    if (query.isBlank()) return commands.toList()
    val lower = query.lowercase()
    return commands.filter { fuzzyMatch(it.label.lowercase(), lower) }
  }
}

/** Simple fuzzy match: all characters of the query appear in order in the target. */
internal fun fuzzyMatch(target: String, query: String): Boolean {
  var qi = 0
  for (ch in target) {
    if (qi < query.length && ch == query[qi]) qi++
  }
  return qi == query.length
}

/** Builds the default set of commands for the application. */
fun buildDefaultCommands(
  onToggleLeftPane: () -> Unit,
  onToggleRightPane: () -> Unit,
  onToggleBottomPane: () -> Unit,
  onClearTelemetry: () -> Unit,
  onExportEvents: () -> Unit,
  onSwitchToDarkMode: () -> Unit,
  onSwitchToLightMode: () -> Unit,
  onOpenSettings: () -> Unit,
  onTakeScreenshot: () -> Unit,
  onToggleLiveLayout: () -> Unit,
): List<Command> =
  listOf(
    Command("toggle_left_pane", "Toggle Left Pane", "Cmd+1", onToggleLeftPane),
    Command("toggle_right_pane", "Toggle Right Pane", "Cmd+2", onToggleRightPane),
    Command("toggle_bottom_pane", "Toggle Bottom Pane", "Cmd+3", onToggleBottomPane),
    Command("clear_telemetry", "Clear Telemetry Events", "", onClearTelemetry),
    Command("export_events", "Export Events as JSON", "", onExportEvents),
    Command("dark_mode", "Switch to Dark Mode", "", onSwitchToDarkMode),
    Command("light_mode", "Switch to Light Mode", "", onSwitchToLightMode),
    Command("open_settings", "Open Settings", "Cmd+,", onOpenSettings),
    Command("take_screenshot", "Take Screenshot", "", onTakeScreenshot),
    Command("toggle_live_layout", "Toggle Live Layout", "", onToggleLiveLayout),
  )

/**
 * VS Code-style command palette overlay triggered by Cmd+Shift+P. Full-screen semi-transparent
 * overlay with centered search card.
 */
@Composable
fun CommandPalette(
  registry: CommandRegistry,
  onDismiss: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  var query by remember { mutableStateOf("") }
  var selectedIndex by remember { mutableIntStateOf(0) }
  val results = remember(query) { registry.search(query.trim()) }
  val focusRequester = remember { FocusRequester() }

  LaunchedEffect(Unit) { focusRequester.requestFocus() }
  LaunchedEffect(results.size) {
    if (selectedIndex >= results.size) selectedIndex = 0
  }

  Box(
    modifier =
      Modifier.fillMaxSize()
        .background(colors.text.normal.copy(alpha = 0.4f))
        .clickable(onClick = onDismiss),
    contentAlignment = Alignment.TopCenter,
  ) {
    Column(
      modifier =
        Modifier.padding(top = 80.dp)
          .widthIn(max = 600.dp)
          .fillMaxWidth(0.8f)
          .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
          .clickable(enabled = false, onClick = {}) // block click-through
          .onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when (event.key) {
              Key.Escape -> {
                onDismiss()
                true
              }
              Key.DirectionDown -> {
                if (results.isNotEmpty()) {
                  selectedIndex = (selectedIndex + 1).mod(results.size)
                }
                true
              }
              Key.DirectionUp -> {
                if (results.isNotEmpty()) {
                  selectedIndex = (selectedIndex - 1).mod(results.size)
                }
                true
              }
              Key.Enter -> {
                results.getOrNull(selectedIndex)?.let {
                  it.action()
                  onDismiss()
                }
                true
              }
              else -> false
            }
          }
    ) {
      TextField(
        value = query,
        onValueChange = { query = it },
        singleLine = true,
        placeholder = { Text(">") },
        leadingIcon = { Text(">", fontSize = 16.sp, fontWeight = FontWeight.Bold) },
        modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
        textStyle = MaterialTheme.typography.bodyLarge,
      )

      LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp)) {
        itemsIndexed(results) { index, command ->
          val isSelected = index == selectedIndex
          val bg =
            if (isSelected) {
              MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
            } else {
              MaterialTheme.colorScheme.surface
            }
          Row(
            modifier =
              Modifier.fillMaxWidth()
                .background(bg)
                .clickable {
                  command.action()
                  onDismiss()
                }
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(
              text = command.label,
              fontSize = 14.sp,
              color = colors.text.normal,
              modifier = Modifier.weight(1f),
            )
            if (command.shortcut.isNotEmpty()) {
              Spacer(Modifier.width(8.dp))
              Text(
                text = command.shortcut,
                fontSize = 12.sp,
                fontWeight = FontWeight.Light,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
            }
          }
        }
      }

      if (results.isEmpty() && query.isNotBlank()) {
        Box(
          modifier = Modifier.fillMaxWidth().padding(16.dp),
          contentAlignment = Alignment.Center,
        ) {
          Text(
            text = "No matching commands",
            fontSize = 13.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
          )
        }
      }
    }
  }
}
