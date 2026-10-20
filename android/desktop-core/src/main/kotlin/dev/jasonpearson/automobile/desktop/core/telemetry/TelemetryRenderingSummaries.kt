package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.formatUiNumber

@Composable
internal fun LayoutSummary(event: TelemetryDisplayEvent.Layout, textColor: Color) {
  val text = layoutSummaryText(event)
  val color =
    when (event.subType) {
      "excessive_recomposition" -> Color(0xFFFFA94D) // orange
      "recomposition" -> Color(0xFF74C0FC) // light blue
      else -> textColor.copy(alpha = 0.7f)
    }

  Text(
    text,
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

@Composable
internal fun PerformanceSummary(event: TelemetryDisplayEvent.Performance, textColor: Color) {
  val changed = event.changedMetrics.joinToString(", ")
  val metrics = buildString {
    event.fps?.let { append("${it.toInt()}fps ") }
    event.frameTimeMs?.let { append("${it.toInt()}ms ") }
    event.jankFrames?.let { if (it > 0) append("${it}jank ") }
    event.memoryUsageMb?.let { append("${it.toInt()}MB ") }
  }
    .trim()
  val text = "[${event.health.uppercase()}] $metrics ($changed)"
  val color =
    when (event.health) {
      "critical" -> Color(0xFFFF4040)
      "warning" -> Color(0xFFFFA94D)
      else -> Color(0xFF51CF66)
    }

  Text(
    text,
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

@Composable
internal fun MemorySummary(event: TelemetryDisplayEvent.Memory, textColor: Color) {
  val status = if (event.passed) "PASS" else "FAIL"
  val growth = event.javaHeapGrowthMb?.let { "+${formatUiNumber("%.1f", it)}MB" } ?: ""
  val text = "[$status] ${event.packageName.substringAfterLast('.')} $growth"
  val color = if (event.passed) Color(0xFF51CF66) else Color(0xFFFF6B6B)
  Text(text, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
}

@Composable
internal fun ToolCallSummary(event: TelemetryDisplayEvent.ToolCall, textColor: Color) {
  val status = if (event.success) "${event.durationMs}ms" else "FAILED"
  val err = event.error
  val errorSuffix = if (!event.success && err != null) " (${err.take(30)})" else ""
  val color =
    when {
      !event.success -> Color(0xFFFF6B6B)
      event.durationMs > 5000 -> Color(0xFFFFA94D)
      else -> Color(0xFF51CF66)
    }
  Text(
    "${event.toolName} $status$errorSuffix",
    fontSize = 11.sp,
    fontFamily = FontFamily.Monospace,
    color = color,
    maxLines = 1,
  )
}

@Composable
internal fun A11ySummary(event: TelemetryDisplayEvent.Accessibility, textColor: Color) {
  val color = if (event.newViolations > 0) Color(0xFFFFA94D) else Color(0xFF51CF66)
  val text = "${event.newViolations} violations (${event.packageName.substringAfterLast('.')})"
  Text(text, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = color, maxLines = 1)
}

private fun layoutSummaryText(event: TelemetryDisplayEvent.Layout): String =
  when (event.subType) {
    "excessive_recomposition" -> {
      val name = event.composableName ?: "unknown"
      val count = event.recompositionCount?.let { "${it}/s" } ?: ""
      val cause = event.likelyCause?.let { " ($it)" } ?: ""
      "RECOMP $name $count$cause"
    }
    "recomposition" -> {
      val name = event.composableName ?: "unknown"
      val count = event.recompositionCount?.let { "${it}/s" } ?: ""
      "recomp $name $count"
    }
    "hierarchy_change" -> "Hierarchy update"
    else -> event.subType
  }
