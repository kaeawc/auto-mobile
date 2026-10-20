package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.components.SearchBarOptions
import dev.jasonpearson.automobile.desktop.core.theme.AppIcons
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.launch

@Composable
internal fun androidx.compose.foundation.layout.RowScope.ClearTelemetryButton(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  buttonModifier: Modifier,
  coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Clear all events
      Box(
        modifier =
          Modifier.clickable {
              events.clear()
              onEventSelected(null)
              categoryCounts.clear()
              lastSeenCounts.clear()
            }
            .then(buttonModifier),
      ) {
        Icon(
          AppIcons.Delete,
          contentDescription = "Clear",
          modifier = Modifier.size(14.dp),
          tint = colors.text.normal,
        )
      }
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.PauseTelemetryButton(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  buttonModifier: Modifier,
  coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Pause / Resume
      Box(
        modifier =
          Modifier.clickable {
              isPaused = !isPaused
              if (!isPaused) {
                autoScrollEnabled = true
                coroutineScope.launch {
                  val lastVisibleRow =
                    if (selectedFilter == CategoryFilter.Network) {
                      filteredEvents.lastIndex
                    } else {
                      renderedRows.lastIndex
                    }
                  if (lastVisibleRow >= 0) {
                    listState.animateScrollToItem(lastVisibleRow)
                  }
                }
              }
            }
            .then(buttonModifier)
            .then(
              if (isPaused)
                Modifier.background(
                  Color(0xFFFFA94D).copy(alpha = 0.15f),
                  RoundedCornerShape(4.dp),
                )
              else Modifier,
            ),
      ) {
        Icon(
          if (isPaused) AppIcons.Play else AppIcons.Pause,
          contentDescription = if (isPaused) "Resume" else "Pause",
          modifier = Modifier.size(14.dp),
          tint = colors.text.normal,
        )
      }
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.RestartTelemetryButton(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  buttonModifier: Modifier,
  coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Restart (clear + unpause + scroll to bottom)
      Box(
        modifier =
          Modifier.clickable {
              events.clear()
              onEventSelected(null)
              isPaused = false
              autoScrollEnabled = true
              categoryCounts.clear()
              lastSeenCounts.clear()
            }
            .then(buttonModifier),
      ) {
        Icon(
          AppIcons.Refresh,
          contentDescription = "Restart",
          modifier = Modifier.size(14.dp),
          tint = colors.text.normal,
        )
      }
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.LatestTelemetryButton(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  buttonModifier: Modifier,
  coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Scroll to latest (bottom) + re-enable auto-scroll
      Box(
        modifier =
          Modifier.clickable {
              autoScrollEnabled = true
              val lastVisibleRow =
                if (selectedFilter == CategoryFilter.Network) {
                  filteredEvents.lastIndex
                } else {
                  renderedRows.lastIndex
                }
              if (lastVisibleRow >= 0) {
                coroutineScope.launch { listState.animateScrollToItem(lastVisibleRow) }
              }
            }
            .then(buttonModifier)
            .then(
              if (autoScrollEnabled)
                Modifier.background(
                  Color(0xFF74C0FC).copy(alpha = 0.15f),
                  RoundedCornerShape(4.dp),
                )
              else Modifier,
            ),
      ) {
        Icon(
          AppIcons.ScrollDown,
          contentDescription = "Scroll to bottom",
          modifier = Modifier.size(14.dp),
          tint = colors.text.normal,
        )
      }
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.BookmarkTelemetryButton(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  buttonModifier: Modifier,
  coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Bookmarks toggle
      Box(
        modifier =
          Modifier.clickable { showBookmarksOnly = !showBookmarksOnly }
            .then(buttonModifier)
            .then(
              if (showBookmarksOnly)
                Modifier.background(
                  Color(0xFFFFD43B).copy(alpha = 0.15f),
                  RoundedCornerShape(4.dp),
                )
              else Modifier,
            ),
      ) {
        Text(
          if (showBookmarksOnly) "\u2605" else "\u2606", // ★ filled / ☆ outline
          fontSize = 13.sp,
        )
      }

      Spacer(Modifier.width(4.dp))
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.TelemetryBufferControl(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  buttonModifier: Modifier,
  coroutineScope: kotlinx.coroutines.CoroutineScope,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Buffer fill indicator + configurable max events
      Box {
        Box(
          modifier =
            Modifier.background(
                colors.text.normal.copy(alpha = 0.05f),
                RoundedCornerShape(4.dp),
              )
              .clickable { showMaxEventsDropdown = !showMaxEventsDropdown }
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = 6.dp, vertical = 4.dp),
        ) {
          Text(
            "${events.size}/$maxEvents",
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
        }
        if (showMaxEventsDropdown) {
          // Dropdown overlay
          Column(
            modifier =
              Modifier.padding(top = 28.dp)
                .background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
                .padding(2.dp),
          ) {
            MAX_EVENTS_OPTIONS.forEach { option ->
              TelemetryBufferOption(ui, option)
            }
          }
        }
      }
    }
  }
}

@Composable
internal fun TelemetrySearchToolbar(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Search bar + severity toggle row
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        SearchBar(
          query = searchQuery,
          onQueryChange = { searchQuery = it },
          modifier = Modifier.weight(1f),
          options =
            SearchBarOptions(
              placeholder = "Filter events...",
              showRegexToggle = true,
              isRegexEnabled = isRegexEnabled,
              onRegexToggle = { isRegexEnabled = !isRegexEnabled },
            ),
        )
        // Severity toggle chips
        EventSeverity.entries.forEach { sev ->
          val isEnabled = sev in enabledSeverities
          Box(
            modifier =
              Modifier.background(
                  if (isEnabled) Color(sev.color).copy(alpha = 0.15f) else Color.Transparent,
                  RoundedCornerShape(4.dp),
                )
                .clickable {
                  enabledSeverities =
                    if (isEnabled) enabledSeverities - sev else enabledSeverities + sev
                }
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 6.dp, vertical = 4.dp),
          ) {
            Icon(
              sev.icon,
              contentDescription = sev.label,
              modifier = Modifier.size(13.dp),
              tint = Color(sev.color),
            )
          }
        }

        // Spacer between severity chips and action buttons
        Spacer(Modifier.width(8.dp))

        // Action buttons (like Logcat toolbar)
        val coroutineScope = rememberCoroutineScope()
        val buttonModifier =
          Modifier.background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 6.dp, vertical = 4.dp)

        ClearTelemetryButton(options, ui, buttonModifier, coroutineScope)
        PauseTelemetryButton(options, ui, buttonModifier, coroutineScope)
        RestartTelemetryButton(options, ui, buttonModifier, coroutineScope)
        LatestTelemetryButton(options, ui, buttonModifier, coroutineScope)
        BookmarkTelemetryButton(options, ui, buttonModifier, coroutineScope)
        TelemetryBufferControl(options, ui, buttonModifier, coroutineScope)
      }
    }
  }
}

@Composable
private fun TelemetryBufferOption(ui: TelemetryDashboardState, option: Int) {
  val colors = SharedTheme.globalColors
  with(ui) {
    val isCurrentOption = option == maxEvents
    Box(
      modifier =
        Modifier.background(
            if (isCurrentOption) colors.text.normal.copy(alpha = 0.12f) else Color.Transparent,
            RoundedCornerShape(3.dp),
          )
          .clickable {
            maxEvents = option
            showMaxEventsDropdown = false
            trimEvents(events, option, categoryCounts)
          }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
      Text(
        "$option",
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
        color = if (isCurrentOption) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
      )
    }
  }
}
