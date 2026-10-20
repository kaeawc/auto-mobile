package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.components.SearchBarOptions
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Always-on filter bar: a full-width free-text search field over a horizontally-scrollable row of
 * per-[LogLevel] toggle chips. Keeping the chips on their own scrolling row means they can never
 * clip or squeeze the search field in a narrow device column — the search stays fully usable and
 * the overflowing chips scroll instead.
 */
@Composable
internal fun LogsFilterBar(
  query: String,
  tag: String,
  enabledLevels: Set<LogLevel>,
  showInternalTags: Boolean,
  options: LogsFilterActions,
) {
  return with(options) {
    var extrasExpanded by remember { mutableStateOf(false) }
    val menu = remember { LogsMenuState() }
    Column(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      SearchBar(
        query = query,
        onQueryChange = onQueryChange,
        modifier = Modifier.fillMaxWidth(),
        options = SearchBarOptions(placeholder = "Filter logs..."),
      )
      Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        Text(
          "Views",
          fontSize = 11.sp,
          modifier =
            Modifier.clickable { extrasExpanded = !extrasExpanded }
              .semantics { contentDescription = "Toggle Logs filters and views" }
              .padding(horizontal = 6.dp, vertical = 4.dp),
        )
        LogLevel.entries.forEach { level ->
          LevelChip(
            level = level,
            isEnabled = level in enabledLevels,
            onToggle = { onToggleLevel(level) },
          )
        }
      }
      if (extrasExpanded) {
        ExtraLogFilters(tag, showInternalTags, menu)
      }
    }
  }
}

/** A single toggle chip for one [LogLevel], with switch-role selected semantics for a11y. */
@Composable
internal fun LevelChip(level: LogLevel, isEnabled: Boolean, onToggle: () -> Unit) {
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
        },
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

@Composable
private fun LogsFilterActions.ExtraLogFilters(
  tag: String,
  showInternalTags: Boolean,
  menu: LogsMenuState,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    SearchBar(
      query = tag,
      onQueryChange = onTagChange,
      modifier = Modifier.weight(1f).semantics { contentDescription = "Filter Logs by tag" },
      options = SearchBarOptions(placeholder = "Tag contains..."),
    )
    Text(
      "AutoMobile",
      fontSize = 11.sp,
      modifier =
        Modifier.background(
            if (showInternalTags) Color(0xFF74C0FC).copy(alpha = 0.18f) else Color.Transparent,
            RoundedCornerShape(4.dp),
          )
          .clickable(onClick = onToggleInternalTags)
          .pointerHoverIcon(PointerIcon.Hand)
          .semantics {
            contentDescription = "Toggle AutoMobile internal logs"
            stateDescription = if (showInternalTags) "Shown" else "Hidden"
            selected = showInternalTags
            role = Role.Switch
          }
          .padding(horizontal = 6.dp, vertical = 4.dp),
    )
    SavedViewsMenu(menu)
  }
}
