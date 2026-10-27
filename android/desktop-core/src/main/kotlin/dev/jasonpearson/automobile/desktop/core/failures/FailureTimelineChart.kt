package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun EventTrendsSection(
  data: TimelineData,
  dateRange: DateRange,
  aggregation: TimeAggregation,
  onBarClick: (() -> Unit)?,
) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(8.dp))
        .padding(12.dp),
  ) {
    TimelineStats(data)
    // Bar chart
    FailureBarChart(data = data.dataPoints, aggregation = aggregation, onBarClick = onBarClick)
  }
}

@Composable
internal fun FailureBarChart(
  data: List<TimelineDataPoint>,
  aggregation: TimeAggregation,
  onBarClick: (() -> Unit)?,
) {
  val colors = SharedTheme.globalColors
  val maxValue = data.maxOfOrNull { it.total } ?: 1
  val chartHeight = 80.dp

  Column {
    // Bars
    Row(
      modifier = Modifier.fillMaxWidth().height(chartHeight),
      horizontalArrangement = Arrangement.spacedBy(2.dp),
      verticalAlignment = Alignment.Bottom,
    ) {
      data.forEach { point ->
        val barHeight = if (maxValue > 0) (point.total.toFloat() / maxValue) else 0f

        Column(
          modifier =
            Modifier.weight(1f)
              .height(chartHeight)
              .then(
                if (onBarClick != null) {
                  Modifier.clickable(onClick = onBarClick).pointerHoverIcon(PointerIcon.Hand)
                } else Modifier,
              ),
          verticalArrangement = Arrangement.Bottom,
        ) {
          // Stacked bar: crashes (red) + ANRs (orange) + tool failures (purple) + nonfatals (blue)
          FailureStackedBar(point, barHeight, chartHeight)
        }
      }
    }

    // X-axis labels (show every few labels to avoid crowding)
    FailureChartLabels(data)
  }
}

@Composable
internal fun FailureStackedBar(
  point: TimelineDataPoint,
  barHeight: Float,
  chartHeight: androidx.compose.ui.unit.Dp,
) {
  if (point.total > 0) {
    val crashHeight = point.crashes.toFloat() / point.total * barHeight
    val anrHeight = point.anrs.toFloat() / point.total * barHeight
    val toolHeight = point.toolFailures.toFloat() / point.total * barHeight
    val nonfatalHeight = point.nonfatals.toFloat() / point.total * barHeight

    if (point.nonfatals > 0) {
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .height((chartHeight.value * nonfatalHeight).dp)
            .background(
              FailureType.NonFatal.color.copy(alpha = 0.8f),
              RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp),
            ),
      )
    }
    if (point.toolFailures > 0) {
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .height((chartHeight.value * toolHeight).dp)
            .background(FailureType.ToolCallFailure.color.copy(alpha = 0.8f)),
      )
    }
    if (point.anrs > 0) {
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .height((chartHeight.value * anrHeight).dp)
            .background(FailureType.ANR.color.copy(alpha = 0.8f)),
      )
    }
    if (point.crashes > 0) {
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .height((chartHeight.value * crashHeight).dp)
            .background(
              FailureType.Crash.color.copy(alpha = 0.8f),
              RoundedCornerShape(bottomStart = 2.dp, bottomEnd = 2.dp),
            ),
      )
    }
  }
}

@Composable
internal fun FailureChartLabels(data: List<TimelineDataPoint>) {
  val colors = SharedTheme.globalColors
  BoxWithConstraints(modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
    // Dynamically adjust label density based on available width
    val labelStep = failureChartLabelStep(maxWidth, data.size)
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      data
        .filterIndexed { index, _ -> index % labelStep == 0 || index == data.lastIndex }
        .forEach { point ->
          Text(
            point.label,
            fontSize = 8.sp,
            color = colors.text.normal.copy(alpha = 0.4f),
            maxLines = 1,
          )
        }
    }
  }
}

@Composable
internal fun TimelineStats(data: TimelineData) {
  val colors = SharedTheme.globalColors
  BoxWithConstraints(modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
    val showLabels = maxWidth > 350.dp
    Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
      timelineStats(data).forEach { stat ->
        StatBox(
          label = stat.label,
          value = formatCompactNumber(stat.value),
          color = stat.type?.color ?: colors.text.normal,
          options = stat.style.copy(showLabel = showLabels),
        )
      }
    }
  }
}

private fun timelineStats(data: TimelineData): List<FailureTimelineStat> {
  val totalCrashes = data.dataPoints.sumOf { it.crashes }
  val totalAnrs = data.dataPoints.sumOf { it.anrs }
  val totalToolFailures = data.dataPoints.sumOf { it.toolFailures }
  val totalNonfatals = data.dataPoints.sumOf { it.nonfatals }
  val previous = data.previousPeriodTotals.crashes
  val crashDelta = if (previous > 0) (totalCrashes - previous) * 100 / previous else 0
  return listOf(
    FailureTimelineStat(
      "Crashes",
      totalCrashes,
      FailureType.Crash,
      FailureStatStyle(
        emoji = FailureType.Crash.icon,
        delta = if (crashDelta != 0) "${if (crashDelta > 0) "+" else ""}$crashDelta%" else null,
        deltaPositive = crashDelta < 0,
      ),
    ),
    FailureTimelineStat(
      "ANRs",
      totalAnrs,
      FailureType.ANR,
      FailureStatStyle(emoji = FailureType.ANR.icon),
    ),
    FailureTimelineStat(
      "Tool Errors",
      totalToolFailures,
      FailureType.ToolCallFailure,
      FailureStatStyle(emoji = FailureType.ToolCallFailure.icon),
    ),
    FailureTimelineStat(
      "Non-Fatal",
      totalNonfatals,
      FailureType.NonFatal,
      FailureStatStyle(emoji = FailureType.NonFatal.icon),
    ),
    FailureTimelineStat(
      "Total",
      totalCrashes + totalAnrs + totalToolFailures + totalNonfatals,
      null,
      FailureStatStyle(emoji = "📊"),
    ),
  )
}

@Composable
internal fun StatBox(
  label: String,
  value: String,
  color: Color,
  options: FailureStatStyle = FailureStatStyle(),
) {
  return with(options) {
    val colors = SharedTheme.globalColors

    // Auto-size font based on value length to prevent overflow
    val valueFontSize =
      when {
        value.length <= 3 -> 18.sp
        value.length <= 5 -> 14.sp
        else -> 12.sp
      }

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(
        value,
        fontSize = valueFontSize,
        fontWeight = FontWeight.Bold,
        color = color,
        maxLines = 1,
      )
      if (delta != null) {
        Text(
          delta,
          fontSize = 9.sp,
          color = if (deltaPositive) Color(0xFF4CAF50) else Color(0xFFE53935),
          maxLines = 1,
        )
      }
      if (showLabel) {
        Text(
          if (emoji != null) "$emoji $label" else label,
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          maxLines = 1,
        )
      } else if (emoji != null) {
        Text(
          emoji,
          fontSize = 10.sp,
          maxLines = 1,
        )
      }
    }
  }
}

private data class FailureTimelineStat(
  val label: String,
  val value: Int,
  val type: FailureType?,
  val style: FailureStatStyle,
)

private fun failureChartLabelStep(width: androidx.compose.ui.unit.Dp, count: Int): Int =
  when {
    width < 200.dp ->
      when {
        count <= 4 -> 1
        else -> count // Show only first and last
      }
    width < 300.dp ->
      when {
        count <= 4 -> 1
        count <= 8 -> 2
        else -> 4
      }
    else ->
      when {
        count <= 7 -> 1
        count <= 14 -> 2
        count <= 24 -> 4
        else -> 10
      }
  }
