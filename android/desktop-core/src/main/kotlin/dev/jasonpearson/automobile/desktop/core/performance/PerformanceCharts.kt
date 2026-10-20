package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Get fixed Y-axis range for a metric type. Returns Pair(minValue, maxValue) for consistent chart
 * scaling.
 */
internal fun getFixedYAxisRange(metricType: MetricType): Pair<Float, Float> {
  return when (metricType) {
    MetricType.FPS -> 0f to 120f
    MetricType.FrameTime -> 0f to 5000f // 5 seconds
    MetricType.Memory -> 0f to 1024f // 1 GB
    MetricType.TouchLatency -> 0f to 2000f // 2 seconds
    MetricType.Jank -> 0f to 30f // 30 missed frames
    MetricType.TimeToInteractive -> 0f to 5000f // 5 seconds
    MetricType.TimeToFirstFrame -> 0f to 5000f // 5 seconds
    MetricType.RecompositionCount -> 0f to 200f // 200 recomp/s
  }
}

/**
 * Convert a value to logarithmic scale for chart display. Maps values from [0, max] to [0, 1] using
 * log scale.
 */
internal fun toLogScale(value: Float, max: Float): Float {
  if (value <= 0f || max <= 0f) return 0f
  // Use log(1 + value) to handle 0 values smoothly
  // Normalize to [0, 1] range
  return kotlin.math.ln(1f + value) / kotlin.math.ln(1f + max)
}

@Composable
internal fun MiniSparkline(
  data: List<Float>,
  color: Color,
  metricType: MetricType,
  modifier: Modifier = Modifier,
) {
  if (data.isEmpty()) return

  val (_, fixedMax) = getFixedYAxisRange(metricType)

  Box(
    modifier =
      modifier.drawBehind {
        if (data.size < 2) return@drawBehind

        val path = Path()
        val stepX = size.width / (data.size - 1)

        data.forEachIndexed { index, value ->
          val x = index * stepX
          // Use logarithmic scale
          val clampedValue = value.coerceIn(0f, fixedMax)
          val normalizedY = toLogScale(clampedValue, fixedMax)
          val y = size.height - (normalizedY * size.height)

          if (index == 0) {
            path.moveTo(x, y)
          } else {
            path.lineTo(x, y)
          }
        }

        drawPath(
          path = path,
          color = color.copy(alpha = 0.6f),
          style = Stroke(width = 2f),
        )
      },
  )
}

@Composable
internal fun CurrentValueDisplay(metric: PerformanceMetric) {
  val colors = SharedTheme.globalColors

  Column(horizontalAlignment = Alignment.End) {
    Row(
      verticalAlignment = Alignment.Bottom,
      horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
      Text("${metric.currentValue.toInt()}", fontSize = 28.sp)
      Text(metric.unit, fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.5f))
    }
    Text(
      when (metric.trend) {
        MetricTrend.Up -> "↑ Trending up"
        MetricTrend.Down -> "↓ Trending down"
        MetricTrend.Stable -> "→ Stable"
      },
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}

@Composable
internal fun MetricTimelineGraph(metric: PerformanceMetric) {
  val data = metric.history

  if (data.isEmpty()) return

  // Use fixed Y-axis range based on metric type
  val (_, fixedMax) = getFixedYAxisRange(metric.type)

  // Calculate status color (same as tile cards)
  val statusColor =
    when {
      metric.type == MetricType.FPS -> {
        // For FPS, lower is worse
        when {
          metric.currentValue < metric.thresholdCritical -> Color(0xFFFF5722)
          metric.currentValue < metric.thresholdWarning -> Color(0xFFFFC107)
          else -> Color(0xFF4CAF50)
        }
      }
      else -> {
        // For other metrics (latency, time, jank), higher is worse
        when {
          metric.currentValue > metric.thresholdCritical -> Color(0xFFFF5722)
          metric.currentValue > metric.thresholdWarning -> Color(0xFFFFC107)
          else -> Color(0xFF4CAF50)
        }
      }
    }

  Box(
    modifier =
      Modifier.fillMaxWidth().height(150.dp).drawBehind {
        if (data.size < 2) return@drawBehind

        val stepX = size.width / (data.size - 1)

        // Draw data line (same style as tile sparkline, with log scale)
        val path = Path()
        data.forEachIndexed { index, point ->
          val x = index * stepX
          // Use logarithmic scale
          val clampedValue = point.value.coerceIn(0f, fixedMax)
          val normalizedY = toLogScale(clampedValue, fixedMax)
          val y = size.height - (normalizedY * size.height)

          if (index == 0) {
            path.moveTo(x, y)
          } else {
            path.lineTo(x, y)
          }
        }

        drawPath(
          path = path,
          color = statusColor.copy(alpha = 0.6f),
          style = Stroke(width = 2f),
        )
      },
  )
}

@Composable
internal fun ThresholdIndicator(
  label: String,
  value: String,
  color: Color,
) {
  val colors = SharedTheme.globalColors

  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(modifier = Modifier.size(width = 16.dp, height = 2.dp).background(color))
    Text(label, fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
    Text(value, fontSize = 11.sp)
  }
}

// Helper function to calculate metric trend
