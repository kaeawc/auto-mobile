package dev.jasonpearson.automobile.desktop.core.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** A single key binding mapping an action name to a key combination display string. */
data class KeyBinding(
  val actionName: String,
  val displayLabel: String,
  val shortcut: String,
)

/**
 * Keymap holding all action-to-key-combination mappings. Currently read-only with hardcoded
 * defaults.
 */
data class Keymap(val bindings: List<KeyBinding>) {
  fun shortcutFor(actionName: String): String? =
    bindings.find { it.actionName == actionName }?.shortcut

  companion object {
    val Default =
      Keymap(
        bindings =
          listOf(
            KeyBinding("command_palette", "Command Palette", "Cmd+Shift+P"),
            KeyBinding("global_search", "Global Search", "Cmd+Shift+F"),
            KeyBinding("toggle_left_pane", "Toggle Left Pane", "Cmd+1"),
            KeyBinding("toggle_right_pane", "Toggle Right Pane", "Cmd+2"),
            KeyBinding("toggle_bottom_pane", "Toggle Bottom Pane", "Cmd+3"),
            KeyBinding("open_settings", "Open Settings", "Cmd+,"),
            KeyBinding("take_screenshot", "Take Screenshot", "Cmd+Shift+S"),
          )
      )
  }
}

/**
 * Read-only "Keyboard Shortcuts" section for the Settings panel. Shows all current key bindings
 * with a note that customization is coming.
 */
@Composable
fun KeyboardShortcutsSection(
  keymap: Keymap = Keymap.Default,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  Column(modifier = modifier) {
    Text("Keyboard Shortcuts", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(8.dp))

    Text(
      "Current key bindings are shown below. Custom keybinding support is coming in a future release.",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
    Spacer(Modifier.height(12.dp))

    keymap.bindings.forEach { binding ->
      Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = binding.displayLabel,
          fontSize = 13.sp,
          color = colors.text.normal,
        )
        Text(
          text = binding.shortcut,
          fontSize = 12.sp,
          fontWeight = FontWeight.Medium,
          color = colors.text.normal.copy(alpha = 0.6f),
          modifier =
            Modifier.background(
                colors.text.normal.copy(alpha = 0.06f),
                RoundedCornerShape(4.dp),
              )
              .padding(horizontal = 8.dp, vertical = 4.dp),
        )
      }
    }
  }
}
