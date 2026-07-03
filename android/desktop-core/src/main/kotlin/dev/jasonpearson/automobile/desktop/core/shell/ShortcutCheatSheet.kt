package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** Data class representing a single keyboard shortcut entry. */
data class ShortcutEntry(val keys: String, val description: String)

/** Data class representing a category of shortcuts. */
data class ShortcutCategory(val name: String, val shortcuts: List<ShortcutEntry>)

/** Returns the full list of shortcut categories for display. */
fun allShortcutCategories(vimModeEnabled: Boolean): List<ShortcutCategory> = buildList {
  add(
    ShortcutCategory(
      "Panes",
      listOf(
        ShortcutEntry("Cmd+0", "Toggle left pane"),
        ShortcutEntry("Cmd+Shift+0", "Toggle right pane"),
        ShortcutEntry("Cmd+Shift+Y", "Toggle bottom pane"),
        ShortcutEntry("Tab", "Focus next pane"),
        ShortcutEntry("Shift+Tab", "Focus previous pane"),
      ),
    )
  )
  add(
    ShortcutCategory(
      "Navigation",
      listOf(
        ShortcutEntry("Arrow Up", "Previous event"),
        ShortcutEntry("Arrow Down", "Next event"),
        ShortcutEntry("Enter", "Select/inspect event"),
        ShortcutEntry("Escape", "Deselect/close inspector"),
      ),
    )
  )
  add(
    ShortcutCategory(
      "Telemetry",
      listOf(
        ShortcutEntry("Cmd+K", "Quick jump to timestamp"),
        ShortcutEntry("Cmd+/", "Show shortcut cheat sheet"),
      ),
    )
  )
  if (vimModeEnabled) {
    add(
      ShortcutCategory(
        "Vim Mode",
        listOf(
          ShortcutEntry("j", "Move down"),
          ShortcutEntry("k", "Move up"),
          ShortcutEntry("g", "Jump to top"),
          ShortcutEntry("G (Shift+g)", "Jump to bottom"),
          ShortcutEntry("/", "Focus search"),
        ),
      )
    )
  }
}

/**
 * Modal overlay showing all keyboard shortcuts in a centered card. Triggered by Cmd+/ (or Cmd+?).
 */
@Composable
fun ShortcutCheatSheet(
  vimModeEnabled: Boolean,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val categories = remember(vimModeEnabled) { allShortcutCategories(vimModeEnabled) }

  ModalBackdrop(onDismiss = onDismiss, modifier = modifier) {
    Column(
      modifier =
        Modifier.widthIn(max = 520.dp)
          .clip(RoundedCornerShape(12.dp))
          .background(colors.panelBackground)
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            onClick = {},
          )
          .padding(24.dp)
    ) {
      Text(
        text = "Keyboard Shortcuts",
        fontSize = 16.sp,
        fontWeight = FontWeight.Bold,
        color = colors.text.normal,
      )
      Spacer(Modifier.height(16.dp))

      categories.forEachIndexed { index, category ->
        if (index > 0) {
          Spacer(Modifier.height(12.dp))
        }
        Text(
          text = category.name,
          fontSize = 13.sp,
          fontWeight = FontWeight.SemiBold,
          color = colors.text.info,
        )
        Spacer(Modifier.height(4.dp))
        category.shortcuts.forEach { shortcut ->
          ShortcutRow(
            keys = shortcut.keys,
            description = shortcut.description,
            textColor = colors.text.normal,
          )
        }
      }

      Spacer(Modifier.height(16.dp))
      Text(
        text = "Press Escape or click outside to close",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }
  }
}

@Composable
private fun ShortcutRow(
  keys: String,
  description: String,
  textColor: Color,
) {
  Row(
    modifier = Modifier.padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.Start,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = keys,
      fontSize = 12.sp,
      fontWeight = FontWeight.Medium,
      color = textColor,
      modifier = Modifier.width(140.dp),
    )
    Text(
      text = description,
      fontSize = 12.sp,
      color = textColor.copy(alpha = 0.7f),
    )
  }
}
