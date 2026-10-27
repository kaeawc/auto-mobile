package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date

private data class NetworkColumn(val label: String, val width: Int)

private val networkColumns =
  listOf(
    NetworkColumn("Time", 90),
    NetworkColumn("Method", 55),
    NetworkColumn("Status", 50),
    NetworkColumn("Host", 140),
    NetworkColumn("Path", 160),
    NetworkColumn("Duration", 70),
    NetworkColumn("Error", 180),
  )

internal data class NetworkTableOptions(
  val events: List<TelemetryDisplayEvent.Network>,
  val listState: androidx.compose.foundation.lazy.LazyListState,
  val timeFormat: SimpleDateFormat,
  val textColor: Color,
  val selectedEvent: TelemetryDisplayEvent? = null,
  val onEventSelected: (TelemetryDisplayEvent.Network) -> Unit = {},
)

@Composable
internal fun NetworkTable(options: NetworkTableOptions) {
  val events = options.events
  val listState = options.listState
  val timeFormat = options.timeFormat
  val textColor = options.textColor
  val selectedEvent = options.selectedEvent
  val onEventSelected = options.onEventSelected

  val scrollState = rememberScrollState()

  Column(modifier = Modifier.fillMaxSize()) {
    // Header row
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .background(textColor.copy(alpha = 0.05f))
          .horizontalScroll(scrollState)
          .padding(vertical = 6.dp),
    ) {
      networkColumns.forEach { col ->
        Box(modifier = Modifier.width(col.width.dp).padding(horizontal = 6.dp)) {
          Text(
            col.label,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
            color = textColor,
            maxLines = 1,
          )
        }
      }
    }

    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(textColor.copy(alpha = 0.1f)))

    // Data rows
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
      items(events, key = { "${it.timestamp}_${System.identityHashCode(it)}" }) { event ->
        val color = networkStatusColor(event.statusCode, event.error, textColor)
        val formattedTime = remember(event.timestamp) { timeFormat.format(Date(event.timestamp)) }
        val isSelected = event == selectedEvent

        Row(
          modifier =
            Modifier.fillMaxWidth()
              .then(
                if (isSelected) Modifier.background(textColor.copy(alpha = 0.08f)) else Modifier,
              )
              .clickable { onEventSelected(event) }
              .pointerHoverIcon(PointerIcon.Hand)
              .horizontalScroll(scrollState)
              .padding(vertical = 3.dp),
        ) {
          NetworkCell(0, formattedTime, textColor.copy(alpha = 0.5f))
          NetworkCell(1, event.method, color)
          NetworkCell(2, "${event.statusCode}", color)
          NetworkCell(3, event.host ?: "", textColor.copy(alpha = 0.85f))
          NetworkCell(4, event.path ?: event.url, textColor.copy(alpha = 0.85f))
          NetworkCell(5, "${event.durationMs}ms", textColor.copy(alpha = 0.7f))
          NetworkCell(6, event.error ?: "", Color(0xFFE06060))
        }
      }
    }
  }
}

@Composable
private fun NetworkCell(index: Int, value: String, color: Color) {
  Box(modifier = Modifier.width(networkColumns[index].width.dp).padding(horizontal = 6.dp)) {
    Text(value, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
  }
}
