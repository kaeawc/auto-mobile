package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.shell.InspectorTabBar

@Composable
internal fun FailureTabbedDetail(
  event: TelemetryDisplayEvent.Failure,
  textColor: Color,
  onOpenSource: ((String, Int, String) -> Unit)?,
  focusedBorderColor: Color,
) {
  val tabs = listOf("Summary", "Stack Trace")
  var selectedTab by remember(event) { mutableStateOf(0) }

  InspectorTabBar(
    tabs = tabs,
    selected = selectedTab,
    onSelect = { selectedTab = it },
    textColor = textColor,
    focusedBorderColor = focusedBorderColor,
  )

  when (selectedTab) {
    0 -> FailureSummaryTab(event, textColor)
    1 -> FailureStackTraceTab(event, textColor, onOpenSource)
  }
}

@Composable
internal fun FailureSummaryTab(event: TelemetryDisplayEvent.Failure, textColor: Color) {
  val severityColor =
    when (event.severity) {
      "critical" -> Color(0xFFFF4040)
      "high" -> Color(0xFFFF6B6B)
      "medium" -> Color(0xFFE0C040)
      else -> textColor.copy(alpha = 0.7f)
    }

  Row(
    modifier = Modifier.padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.background(severityColor.copy(alpha = 0.2f), RoundedCornerShape(3.dp))
          .padding(horizontal = 6.dp, vertical = 1.dp),
    ) {
      Text(
        event.severity.uppercase(),
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        color = severityColor,
      )
    }
  }

  DetailRow("Type", event.type, textColor)
  DetailRow("Title", event.title, textColor)
  event.exceptionType?.let { DetailRow("Exception", it, textColor) }
  event.screen?.let { DetailRow("Screen", it, textColor) }
  DetailRow("Occurrence ID", event.occurrenceId, textColor)
}

@Composable
internal fun FailureStackTraceTab(
  event: TelemetryDisplayEvent.Failure,
  textColor: Color,
  onOpenSource: ((String, Int, String) -> Unit)?,
) {
  val frames = event.stackTrace
  if (frames.isNullOrEmpty()) {
    Text("No stack trace available", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    return
  }

  for (frame in frames) {
    val location = buildString {
      append(frame.fileName ?: frame.className.substringAfterLast('.'))
      if (frame.lineNumber != null) append(":${frame.lineNumber}")
    }
    val frameText = "at ${frame.className}.${frame.methodName}($location)"

    val fName = frame.fileName
    val fLine = frame.lineNumber
    val hasSourceLocation = fName != null && fLine != null
    if (frame.isAppCode && onOpenSource != null && hasSourceLocation) {
      Text(
        frameText,
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.SemiBold,
        color = textColor.copy(alpha = 0.9f),
        modifier =
          Modifier.clickable { onOpenSource(fName, fLine, frame.className) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(vertical = 1.dp),
      )
    } else {
      Text(
        frameText,
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        color = textColor.copy(alpha = 0.4f),
        modifier = Modifier.padding(vertical = 1.dp),
      )
    }
  }
}
