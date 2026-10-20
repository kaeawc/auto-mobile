package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun ToolCallDetailsSection(
  toolCallInfo: AggregatedToolCallInfo,
  expandedState: ExpandableListState,
  onToggle: (FailureSection) -> Unit,
) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    DetailRow("Tool", toolCallInfo.toolName)

    // Error codes breakdown
    ToolErrorCodes(toolCallInfo, expandedState, onToggle)

    // Duration stats
    val stats = toolCallInfo.durationStats
    if (stats != null) {
      Text("Duration:", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
      Row(
        horizontalArrangement = Arrangement.SpaceEvenly,
        modifier = Modifier.fillMaxWidth(),
      ) {
        DurationStat("Min", stats.minMs)
        DurationStat("Avg", stats.avgMs)
        DurationStat("P95", stats.p95Ms)
        DurationStat("Max", stats.maxMs)
      }
    }

    // Parameter variants
    ToolParameterVariants(toolCallInfo, expandedState, onToggle)
  }
}

@Composable
internal fun ToolErrorCodes(
  toolCallInfo: AggregatedToolCallInfo,
  expandedState: ExpandableListState,
  onToggle: (FailureSection) -> Unit,
) {
  val colors = SharedTheme.globalColors
  if (toolCallInfo.errorCodes.isNotEmpty()) {
    Text("Error Codes:", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
    val sortedCodes = toolCallInfo.errorCodes.entries.sortedByDescending { it.value }
    expandedState.visible(FailureSection.ErrorCodes, sortedCodes).forEach { (code, count) ->
      Row(modifier = Modifier.padding(start = 8.dp)) {
        Text(
          code,
          fontSize = 11.sp,
          fontFamily = FontFamily.Monospace,
          modifier = Modifier.weight(1f),
        )
        Text("${count}x", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
      }
    }
    if (sortedCodes.size > 5) {
      ViewAllLink(
        if (expandedState.isExpanded(FailureSection.ErrorCodes)) "Show less"
        else "View all ${sortedCodes.size} error codes",
      ) {
        onToggle(FailureSection.ErrorCodes)
      }
    }
  }
}

@Composable
internal fun ToolParameterVariants(
  toolCallInfo: AggregatedToolCallInfo,
  expandedState: ExpandableListState,
  onToggle: (FailureSection) -> Unit,
) {
  val colors = SharedTheme.globalColors
  if (toolCallInfo.parameterVariants.isNotEmpty()) {
    Text("Parameters:", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
    val params = toolCallInfo.parameterVariants.entries.toList()
    expandedState.visible(FailureSection.Parameters, params).forEach { (param, values) ->
      Row(modifier = Modifier.padding(start = 8.dp)) {
        Text("$param: ", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.5f))
        Text(
          if (values.size == 1) values.first() else "${values.size} variants",
          fontSize = 11.sp,
          fontFamily = FontFamily.Monospace,
        )
      }
    }
    if (params.size > 5) {
      ViewAllLink(
        if (expandedState.isExpanded(FailureSection.Parameters)) "Show less"
        else "View all ${params.size} parameters",
      ) {
        onToggle(FailureSection.Parameters)
      }
    }
  }
}
