package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp

@Composable
internal fun LogSummary(event: TelemetryDisplayEvent.Log, textColor: Color) {
  val levelLetter = logLevelLetter(event.level)
  val color =
    when (event.level) {
      2 -> textColor.copy(alpha = 0.4f) // Verbose
      3 -> textColor.copy(alpha = 0.6f) // Debug
      4 -> textColor.copy(alpha = 0.85f) // Info
      5 -> Color(0xFFE0C040) // Warning - yellow
      6 -> Color(0xFFE06060) // Error - red
      7 -> Color(0xFFFF4040) // Assert - bright red
      else -> textColor.copy(alpha = 0.6f)
    }

  Text(
    "$levelLetter [${event.tag}] ${event.message}",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

@Composable
internal fun NavigationSummary(event: TelemetryDisplayEvent.Navigation, textColor: Color) {
  val argsText = event.arguments?.entries?.joinToString(", ") { "${it.key}=${it.value}" }
  val suffix = if (argsText != null) " ($argsText)" else ""

  Text(
    "${event.destination}$suffix",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = Color(0xFF74C0FC), // light blue
    maxLines = 1,
  )
}

@Composable
internal fun OsSummary(event: TelemetryDisplayEvent.Os, textColor: Color) {
  val d = event.details
  val detailsText =
    if (d != null && d.isNotEmpty()) {
      " ${d.entries.joinToString(", ") { "${it.key}:${it.value}" }}"
    } else {
      ""
    }
  val color =
    when (event.kind) {
      "foreground" -> Color(0xFF51CF66) // green
      "background" -> Color(0xFFFFA94D) // orange
      "connectivity_change" -> {
        val connected = event.details?.get("connected")
        if (connected == "true") Color(0xFF51CF66) else Color(0xFFFF6B6B)
      }
      "screen_off" -> textColor.copy(alpha = 0.4f)
      else -> textColor.copy(alpha = 0.85f)
    }

  Text(
    "[${event.category}] ${event.kind}$detailsText",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

@Composable
internal fun FailureSummary(event: TelemetryDisplayEvent.Failure, textColor: Color) {
  val color =
    when (event.severity) {
      "critical" -> Color(0xFFFF4040) // bright red
      "high" -> Color(0xFFFF6B6B) // red
      "medium" -> Color(0xFFE0C040) // yellow
      "low" -> textColor.copy(alpha = 0.7f)
      else -> textColor.copy(alpha = 0.85f)
    }
  val typeLabel =
    when (event.type) {
      "crash" -> "CRASH"
      "anr" -> "ANR"
      "nonfatal" -> "NON-FATAL"
      else -> event.type.uppercase()
    }
  val screenSuffix = event.screen?.let { " @ $it" } ?: ""

  Text(
    "[$typeLabel] ${event.title}$screenSuffix",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

@Composable
internal fun StorageSummary(event: TelemetryDisplayEvent.Storage, textColor: Color) {
  val changeLabel = event.changeType.uppercase()
  val keyPart = event.key?.let { ":$it" } ?: ""
  val valuePart = event.value?.let { " = $it" } ?: ""

  Text(
    "[$changeLabel] ${event.fileName}$keyPart$valuePart",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = textColor.copy(alpha = 0.85f),
    maxLines = 1,
  )
}

private fun logLevelLetter(level: Int): String =
  when (level) {
    2 -> "V"
    3 -> "D"
    4 -> "I"
    5 -> "W"
    6 -> "E"
    7 -> "A"
    else -> "?"
  }
