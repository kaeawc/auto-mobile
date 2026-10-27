package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.performance.HealthStatus
import dev.jasonpearson.automobile.desktop.core.performance.MetricDataPoint
import dev.jasonpearson.automobile.desktop.core.performance.MetricTrend
import dev.jasonpearson.automobile.desktop.core.performance.MetricType
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceAnomaly
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceMetric
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceRun

internal fun aggregatePerformance(
  auditResult: dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult,
): Result<PerformanceRun> {
  // Aggregate metrics from audit results
  val now = System.currentTimeMillis()
  val screensAnalyzed = mutableSetOf<String>()

  val (metrics, anomalies) = collectAuditMetrics(auditResult)

  // Determine overall health
  val overallHealth =
    when {
      anomalies.any { it.severity == HealthStatus.Critical } -> HealthStatus.Critical
      anomalies.isNotEmpty() -> HealthStatus.Warning
      else -> HealthStatus.Healthy
    }

  val latestEntry = auditResult.results.maxByOrNull { parseTimestamp(it.timestamp) }

  return Result.Success(
    PerformanceRun(
      id = "mcp-run-${now}",
      name = "MCP Performance Data",
      timestamp = latestEntry?.let { parseTimestamp(it.timestamp) } ?: now,
      durationMs = 0, // Not tracked in audit results
      deviceName = latestEntry?.deviceId ?: "Unknown",
      overallHealth = overallHealth,
      metrics = metrics,
      anomalies = anomalies,
      screensAnalyzed = screensAnalyzed.toList(),
    ),
  )
}

private fun collectAuditMetrics(
  auditResult: dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult,
): Pair<List<PerformanceMetric>, List<PerformanceAnomaly>> {
  val metrics = mutableListOf<PerformanceMetric>()
  val anomalies = mutableListOf<PerformanceAnomaly>()
  // Collect metrics from audit entries
  val p50Values = mutableListOf<MetricDataPoint>()
  val p90Values = mutableListOf<MetricDataPoint>()
  val jankCounts = mutableListOf<MetricDataPoint>()
  val touchLatencies = mutableListOf<MetricDataPoint>()

  auditResult.results.forEach { entry ->
    val timestamp = parseTimestamp(entry.timestamp)

    entry.metrics.p50Ms?.let { p50 ->
      p50Values.add(MetricDataPoint(timestamp, p50.toFloat()))
    }
    entry.metrics.p90Ms?.let { p90 ->
      p90Values.add(MetricDataPoint(timestamp, p90.toFloat()))
    }
    entry.metrics.jankCount?.let { jank ->
      jankCounts.add(MetricDataPoint(timestamp, jank.toFloat()))
    }
    entry.metrics.touchLatencyMs?.let { latency ->
      touchLatencies.add(MetricDataPoint(timestamp, latency.toFloat()))
    }

    // Check for anomalies (failures)
    if (!entry.passed) {
      anomalies.add(
        PerformanceAnomaly(
          id = "anomaly-${entry.id}",
          metricType = MetricType.Jank,
          severity = HealthStatus.Warning,
          message = entry.diagnostics ?: "Performance audit failed",
          timestamp = timestamp,
          screenName = null,
          testName = null,
          value = entry.metrics.jankCount?.toFloat() ?: 0f,
          threshold = 5f, // Default threshold
        ),
      )
    }
  }

  // Build metrics from collected data
  if (p50Values.isNotEmpty()) metrics.add(frameP50Metric(p50Values))

  if (p90Values.isNotEmpty()) metrics.add(frameP90Metric(p90Values))

  if (jankCounts.isNotEmpty()) metrics.add(jankMetric(jankCounts))

  if (touchLatencies.isNotEmpty()) metrics.add(touchLatencyMetric(touchLatencies))

  return metrics to anomalies
}

private fun frameP50Metric(p50Values: List<MetricDataPoint>): PerformanceMetric {

  val currentValue = p50Values.lastOrNull()?.value ?: 0f
  return PerformanceMetric(
    id = "p50_frame_time",
    type = MetricType.TimeToFirstFrame,
    name = "Frame Time (P50)",
    currentValue = currentValue,
    unit = "ms",
    thresholdWarning = 16f, // ~60fps
    thresholdCritical = 33f, // ~30fps
    trend = calculateTrend(p50Values),
    history = p50Values.sortedBy { it.timestamp },
  )
}

private fun frameP90Metric(p90Values: List<MetricDataPoint>): PerformanceMetric {

  val currentValue = p90Values.lastOrNull()?.value ?: 0f
  return PerformanceMetric(
    id = "p90_frame_time",
    type = MetricType.TimeToFirstFrame,
    name = "Frame Time (P90)",
    currentValue = currentValue,
    unit = "ms",
    thresholdWarning = 20f,
    thresholdCritical = 40f,
    trend = calculateTrend(p90Values),
    history = p90Values.sortedBy { it.timestamp },
  )
}

private fun jankMetric(jankCounts: List<MetricDataPoint>): PerformanceMetric {

  val currentValue = jankCounts.lastOrNull()?.value ?: 0f
  return PerformanceMetric(
    id = "jank_count",
    type = MetricType.Jank,
    name = "Jank (Missed Frames)",
    currentValue = currentValue,
    unit = "frames",
    thresholdWarning = 5f,
    thresholdCritical = 10f,
    trend = calculateTrend(jankCounts),
    history = jankCounts.sortedBy { it.timestamp },
  )
}

private fun touchLatencyMetric(touchLatencies: List<MetricDataPoint>): PerformanceMetric {

  val currentValue = touchLatencies.lastOrNull()?.value ?: 0f
  return PerformanceMetric(
    id = "touch_latency",
    type = MetricType.TouchLatency,
    name = "Touch Latency",
    currentValue = currentValue,
    unit = "ms",
    thresholdWarning = 100f,
    thresholdCritical = 200f,
    trend = calculateTrend(touchLatencies),
    history = touchLatencies.sortedBy { it.timestamp },
  )
}

internal fun createEmptyRun(): PerformanceRun {
  return PerformanceRun(
    id = "empty-run",
    name = "No data available",
    timestamp = System.currentTimeMillis(),
    durationMs = 0,
    deviceName = "Unknown",
    overallHealth = HealthStatus.Healthy,
    metrics = emptyList(),
    anomalies = emptyList(),
    screensAnalyzed = emptyList(),
  )
}

private fun parseTimestamp(timestamp: String): Long {
  return try {
    java.time.Instant.parse(timestamp).toEpochMilli()
  } catch (e: java.time.format.DateTimeParseException) {
    LoggerFactory.getLogger("RealPerformanceDataSource")
      .warn("Invalid audit timestamp: $timestamp", e)
    System.currentTimeMillis()
  }
}

private fun calculateTrend(values: List<MetricDataPoint>): MetricTrend {
  if (values.size < 2) return MetricTrend.Stable

  val sorted = values.sortedBy { it.timestamp }
  val recentAvg = sorted.takeLast(5).map { it.value }.average()
  val oldAvg = sorted.take(5).map { it.value }.average()

  val changePercent = if (oldAvg > 0) ((recentAvg - oldAvg) / oldAvg) * 100 else 0.0

  return when {
    changePercent > 10 -> MetricTrend.Up
    changePercent < -10 -> MetricTrend.Down
    else -> MetricTrend.Stable
  }
}
