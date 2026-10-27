package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun TelemetryDashboardContent(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  modifier: Modifier,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      Column(modifier = modifier.fillMaxSize()) {
        TelemetrySearchToolbar(options, ui)
        TelemetryCategoryTabs(options, ui)
        TelemetryConnectionBar(options, ui)
        TelemetryEventsContent(options, ui)
      }
    }
  }
}

@Composable
internal fun TelemetryCategoryTabs(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Responsive category filter tabs
      BoxWithConstraints(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
      ) {
        val tabCount = CategoryFilter.entries.size
        val tabsWithText =
          when {
            maxWidth >= 750.dp -> tabCount
            maxWidth >= 600.dp -> tabCount - 3
            maxWidth >= 450.dp -> tabCount - 6
            maxWidth >= 350.dp -> 3
            else -> 0
          }

        Row(
          modifier = Modifier.horizontalScroll(rememberScrollState()),
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          CategoryFilter.entries.forEachIndexed { index, filter ->
            TelemetryCategoryTab(ui, filter, index, tabsWithText)
          }
        }
      }
    }
  }
}

@Composable
internal fun TelemetryCategoryTab(
  ui: TelemetryDashboardState,
  filter: CategoryFilter,
  index: Int,
  tabsWithText: Int,
) {
  with(ui) {
    val colors = SharedTheme.globalColors
    val isSelected = filter == selectedFilter
    val count = categoryCounts[filter] ?: 0
    val showText = index < tabsWithText
    // Show dot when there are unseen events for this tab
    val lastSeen = lastSeenCounts[filter] ?: 0
    val hasUnseen = !isSelected && filter != CategoryFilter.All && count > lastSeen
    Box(
      modifier =
        Modifier.background(
            if (isSelected) colors.text.normal.copy(alpha = 0.12f) else Color.Transparent,
            RoundedCornerShape(6.dp),
          )
          .clickable {
            selectedFilter = filter
            lastSeenCounts[filter] = categoryCounts[filter] ?: 0
          }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(horizontal = if (showText) 8.dp else 6.dp, vertical = 4.dp),
    ) {
      Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(
          filter.icon,
          contentDescription = filter.label,
          modifier = Modifier.size(13.dp),
          tint = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
        )
        if (showText) {
          Text(
            filter.label,
            fontSize = 11.sp,
            color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
          )
          if (count > 0) {
            Text(
              "$count",
              fontSize = 9.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
            )
          }
        }
        if (hasUnseen) {
          Box(
            modifier =
              Modifier.width(6.dp)
                .height(6.dp)
                .background(Color(0xFFFF6B6B), RoundedCornerShape(3.dp)),
          )
        }
      }
    }
  }
}

@Composable
internal fun TelemetryConnectionBar(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
) {
  val state = ui.connectionState
  if (state == null || state is ConnectionState.Connected) return
  TelemetryConnectionStatusRow(options, state)
}

@Composable
internal fun TelemetryEventsContent(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      // Event list + detail panel
      Row(modifier = Modifier.fillMaxSize()) {
        // Event list (takes remaining space)
        Box(modifier = Modifier.weight(1f)) {
          if (filteredEvents.isEmpty()) {
            Box(
              modifier = Modifier.fillMaxSize(),
              contentAlignment = Alignment.Center,
            ) {
              Text(
                if (dataSourceMode == DataSourceMode.Real) "No telemetry events yet"
                else "No events",
                fontSize = 12.sp,
                color = colors.text.normal.copy(alpha = 0.4f),
              )
            }
          } else if (selectedFilter == CategoryFilter.Network) {
            NetworkTable(
              options =
                NetworkTableOptions(
                  events = filteredEvents.filterIsInstance<TelemetryDisplayEvent.Network>(),
                  listState = listState,
                  timeFormat = timeFormat,
                  textColor = colors.text.normal,
                  selectedEvent = selectedEvent,
                  onEventSelected = { onEventSelected(if (selectedEvent == it) null else it) },
                ),
            )
          } else {
            GroupedTelemetryEvents(options, ui)
          }
        }

        // Detail panel moved to the right inspector pane (RightInspectorPanel)
      }
    }
  }
}

@Composable
internal fun GroupedTelemetryEvents(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
) {
  with(options) {
    with(ui) {
      val colors = SharedTheme.globalColors
      LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
      ) {
        groupedItems.forEachIndexed { index, listItem: EventListItem ->
          when (listItem) {
            is EventListItem.Single -> {
              emitTelemetryEventRow(
                options,
                ui,
                TelemetryRowRequest(listItem.event, "single"),
                colors.text.normal,
              )
            }
            is EventListItem.Group -> {
              val groupId = listItem.categoryKey
              item(key = "group_header_${groupId}_$index") {
                GroupHeader(
                  categoryKey = listItem.categoryKey,
                  count = listItem.events.size,
                  isExpanded = listItem.isExpanded,
                  textColor = colors.text.normal,
                  onClick = {
                    if (groupId in expandedGroups) expandedGroups.remove(groupId)
                    else expandedGroups.add(groupId)
                  },
                )
              }
              if (listItem.isExpanded) {
                listItem.events.forEach { event ->
                  emitTelemetryEventRow(
                    options,
                    ui,
                    TelemetryRowRequest(event, "grouped", true),
                    colors.text.normal,
                  )
                }
              }
            }
          }
        }
      }
    }
  }
}

internal fun androidx.compose.foundation.lazy.LazyListScope.emitTelemetryEventRow(
  options: TelemetryDashboardOptions,
  ui: TelemetryDashboardState,
  request: TelemetryRowRequest,
  textColor: Color,
) {
  val event = request.event
  val keyPrefix = request.keyPrefix
  val indented = request.indented
  with(options) {
    with(ui) {
      item(key = "${keyPrefix}_${event.timestamp}_${System.identityHashCode(event)}") {
        EventRowWithBookmark(
          options =
            EventRowOptions(
              event = event,
              timeFormat = timeFormat,
              textColor = textColor,
              isSelected = event == selectedEvent,
              isBookmarked = event in bookmarkedEvents,
              onToggleBookmark = {
                if (event in bookmarkedEvents) bookmarkedEvents.remove(event)
                else bookmarkedEvents.add(event)
              },
              onClick = { onEventSelected(if (selectedEvent == event) null else event) },
              indented = indented,
            ),
        )
      }
    }
  }
}

internal data class TelemetryRowRequest(
  val event: TelemetryDisplayEvent,
  val keyPrefix: String,
  val indented: Boolean = false,
)

@Composable
private fun TelemetryConnectionStatusRow(
  options: TelemetryDashboardOptions,
  state: ConnectionState,
) {
  val colors = SharedTheme.globalColors
  val telemetryPushClient = options.telemetryPushClient
  val activeDeviceId = options.activeDeviceId
  val statusText =
    when (state) {
      is ConnectionState.Connecting -> "Connecting..."
      is ConnectionState.Reconnecting -> "Reconnecting (attempt ${state.attempt})..."
      is ConnectionState.Disconnected -> "Disconnected${state.reason?.let { ": $it" } ?: ""}"
      is ConnectionState.Error -> "Error: ${state.message}"
      is ConnectionState.Connected -> ""
    }
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(Color(0xFF5C4033).copy(alpha = 0.3f))
        .padding(horizontal = 8.dp, vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      statusText,
      fontSize = 10.sp,
      color = Color(0xFFE0A040),
    )
    if (state is ConnectionState.Error && telemetryPushClient != null) {
      TextButton(onClick = { telemetryPushClient.connect(activeDeviceId) }) { Text("Retry") }
    }
  }
}
