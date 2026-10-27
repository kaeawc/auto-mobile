package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Link
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

private val LOG = LoggerFactory.getLogger("PerformanceDashboard")

enum class PerformanceScreen {
  Overview,
  MetricDetail,
}

@Composable
fun PerformanceDashboard(options: PerformanceDashboardOptions) {
  val initialRun = rememberInitialPerformanceRun(options)
  val state = remember { PerformanceDashboardState(initialRun) }
  ResetPerformanceGenerationEffect(options, state)
  CollectPerformanceMetricsEffect(options, state)
  LoadPerformanceRunEffect(options, state)
  PerformanceDashboardContent(state)
}

@Composable
private fun PerformanceDashboardContent(state: PerformanceDashboardState) {
  when (state.currentScreen) {
    PerformanceScreen.Overview ->
      state.currentRun?.let { run ->
        PerformanceOverviewScreen(
          run = run,
          onMetricSelected = { metric ->
            state.selectedMetric = metric
            state.currentScreen = PerformanceScreen.MetricDetail
          },
        )
      }
    PerformanceScreen.MetricDetail -> {
      // Get the latest version of the metric from state.currentRun for real-time updates
      val run = state.currentRun
      val metric =
        run?.metrics?.find { it.type == state.selectedMetric?.type } ?: state.selectedMetric
      if (metric != null && run != null) {
        MetricDetailScreen(
          metric = metric,
          run = run,
          onBack = { state.currentScreen = PerformanceScreen.Overview },
        )
      } else {
        state.currentScreen = PerformanceScreen.Overview
      }
    }
  }
}

@Composable
private fun PerformanceOverviewScreen(
  run: PerformanceRun,
  onMetricSelected: (PerformanceMetric) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()

  Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
    if (run.metrics.isEmpty()) {
      EmptyPerformanceData()
    }

    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
      val isWide = maxWidth >= 400.dp
      if (isWide && run.metrics.isNotEmpty()) {
        // 2 columns
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          run.metrics.chunked(2).forEach { row ->
            Row(
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              modifier = Modifier.fillMaxWidth(),
            ) {
              row.forEach { metric ->
                MetricCard(
                  metric = metric,
                  onClick = { onMetricSelected(metric) },
                  modifier = Modifier.weight(1f),
                )
              }
              if (row.size == 1) {
                Spacer(Modifier.weight(1f))
              }
            }
          }
        }
      } else if (run.metrics.isNotEmpty()) {
        // Single column
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          run.metrics.forEach { metric ->
            MetricCard(
              metric = metric,
              onClick = { onMetricSelected(metric) },
              modifier = Modifier.fillMaxWidth(),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun MetricDetailScreen(
  metric: PerformanceMetric,
  run: PerformanceRun,
  onBack: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val scrollState = rememberScrollState()

  Column(modifier = Modifier.fillMaxSize().verticalScroll(scrollState).padding(16.dp)) {
    Link("← Back", onClick = onBack)
    Spacer(Modifier.height(12.dp))

    // Header
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column {
        Text(metric.name, fontSize = 18.sp)
      }
      CurrentValueDisplay(metric = metric)
    }

    Spacer(Modifier.height(20.dp))

    // Timeline graph (updates in real-time as metric.history is updated)
    MetricTimelineGraph(metric = metric)

    Spacer(Modifier.height(20.dp))

    // Threshold info
    Text("Thresholds", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.8f))
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
      ThresholdIndicator(
        label = "Warning",
        value = "${metric.thresholdWarning.toInt()}${metric.unit}",
        color = Color(0xFFFFC107),
      )
      ThresholdIndicator(
        label = "Critical",
        value = "${metric.thresholdCritical.toInt()}${metric.unit}",
        color = Color(0xFFFF5722),
      )
    }
  }
}

@Composable
private fun MetricCard(
  metric: PerformanceMetric,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  val statusColor = metricStatusColor(metric)

  val trendIcon =
    when (metric.trend) {
      MetricTrend.Up -> "↑"
      MetricTrend.Down -> "↓"
      MetricTrend.Stable -> "→"
    }

  Box(
    modifier =
      modifier
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(12.dp),
  ) {
    Column {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(metric.name, fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.7f))
        Box(modifier = Modifier.size(8.dp).background(statusColor, CircleShape))
      }

      Spacer(Modifier.height(8.dp))

      Row(
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        Text(
          "${metric.currentValue.toInt()}",
          fontSize = 24.sp,
        )
        Text(
          metric.unit,
          fontSize = 12.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          modifier = Modifier.padding(bottom = 4.dp),
        )
        Spacer(Modifier.weight(1f))
        Text(
          trendIcon,
          fontSize = 14.sp,
          color = colors.text.normal.copy(alpha = 0.4f),
        )
      }

      Spacer(Modifier.height(8.dp))

      // Mini sparkline
      MiniSparkline(
        data = metric.history.takeLast(20).map { it.value },
        color = statusColor,
        metricType = metric.type,
        modifier = Modifier.fillMaxWidth().height(24.dp),
      )
    }
  }
}

internal fun calculateTrend(oldValue: Float, newValue: Float): MetricTrend {
  val diff = newValue - oldValue
  return when {
    diff > 1f -> MetricTrend.Up
    diff < -1f -> MetricTrend.Down
    else -> MetricTrend.Stable
  }
}

// Helper function to calculate overall health from metrics
internal fun calculateOverallHealth(metrics: List<PerformanceMetric>): HealthStatus {
  var hasCritical = false
  var hasWarning = false

  for (metric in metrics) {
    val isBetter =
      when (metric.type) {
        MetricType.FPS -> metric.currentValue >= metric.thresholdWarning
        else -> metric.currentValue <= metric.thresholdWarning
      }
    val isCritical =
      when (metric.type) {
        MetricType.FPS -> metric.currentValue < metric.thresholdCritical
        else -> metric.currentValue > metric.thresholdCritical
      }

    if (isCritical) hasCritical = true
    if (!isBetter) hasWarning = true
  }

  return when {
    hasCritical -> HealthStatus.Critical
    hasWarning -> HealthStatus.Warning
    else -> HealthStatus.Healthy
  }
}

private fun metricStatusColor(metric: PerformanceMetric): Color {
  return when {
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
}

@Composable
private fun EmptyPerformanceData() {
  val colors = SharedTheme.globalColors
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(8.dp))
        .padding(24.dp),
    contentAlignment = Alignment.Center,
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(
        "Waiting for performance data...",
        fontSize = 13.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
      )
      Spacer(Modifier.height(4.dp))
      Text(
        "Interact with your app to see metrics",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }
  }
}
