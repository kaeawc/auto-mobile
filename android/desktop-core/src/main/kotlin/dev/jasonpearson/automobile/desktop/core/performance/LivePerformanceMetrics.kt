package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceStreamUpdate

private data class LiveMetricDefinition(
  val id: String,
  val name: String,
  val unit: String,
  val warning: Float,
  val critical: Float,
)

private fun metricDefinition(type: MetricType): LiveMetricDefinition =
  when (type) {
    MetricType.FPS -> LiveMetricDefinition("fps", "Frame Rate", "fps", 55f, 45f)
    MetricType.FrameTime -> LiveMetricDefinition("frame_time", "Frame Time", "ms", 18f, 33f)
    MetricType.Jank -> LiveMetricDefinition("jank", "Jank (Missed Frames)", "frames", 5f, 10f)
    MetricType.Memory -> LiveMetricDefinition("memory", "Memory Usage", "MB", 256f, 512f)
    MetricType.TouchLatency ->
      LiveMetricDefinition("touch_latency", "Touch Latency", "ms", 100f, 200f)
    MetricType.TimeToInteractive ->
      LiveMetricDefinition("tti", "Time to Interactive", "ms", 700f, 1500f)
    MetricType.RecompositionCount ->
      LiveMetricDefinition("recomposition", "Recompositions", "recomp/s", 10f, 50f)
    MetricType.TimeToFirstFrame -> error("First-frame metrics are not created by the live stream")
  }

private fun liveMetric(
  type: MetricType,
  value: Float,
  timestamp: Long,
  screenName: String? = null,
): PerformanceMetric {
  val definition = metricDefinition(type)
  return PerformanceMetric(
    id = definition.id,
    type = type,
    name = definition.name,
    currentValue = value,
    unit = definition.unit,
    thresholdWarning = definition.warning,
    thresholdCritical = definition.critical,
    trend = MetricTrend.Stable,
    history = listOf(MetricDataPoint(timestamp, value, screenName)),
  )
}

internal fun initialPerformanceMetrics(
  options: PerformanceDashboardOptions,
  timestamp: Long,
): List<PerformanceMetric> =
  with(options) {
    listOfNotNull(
      initialFps?.let { liveMetric(MetricType.FPS, it, timestamp) },
      initialFrameTimeMs?.let { liveMetric(MetricType.FrameTime, it, timestamp) },
      initialJankFrames?.let { liveMetric(MetricType.Jank, it.toFloat(), timestamp) },
      initialMemoryMb?.let { liveMetric(MetricType.Memory, it, timestamp) },
      initialTouchLatencyMs?.let { liveMetric(MetricType.TouchLatency, it, timestamp) },
      initialRecompositionRate?.let { liveMetric(MetricType.RecompositionCount, it, timestamp) },
    )
  }

private fun streamMetricValues(update: PerformanceStreamUpdate): List<Pair<MetricType, Float?>> =
  with(update) {
    listOf(
      MetricType.FPS to fps,
      MetricType.FrameTime to frameTimeMs,
      MetricType.Jank to jankFrames.toFloat(),
      MetricType.Memory to memoryUsageMb,
      MetricType.TouchLatency to touchLatencyMs,
      MetricType.TimeToInteractive to timeToInteractiveMs,
      MetricType.RecompositionCount to recompositionRate,
    )
  }

internal fun updatePerformanceMetrics(
  existing: List<PerformanceMetric>,
  update: PerformanceStreamUpdate,
): List<PerformanceMetric> {
  val values = streamMetricValues(update)
  if (existing.isEmpty())
    return values.mapNotNull { (type, value) ->
      value?.let { liveMetric(type, it, update.timestamp, update.screenName) }
    }
  val existingTypes = existing.map { it.type }.toSet()
  val byType = values.toMap()
  val updated = existing.map { metric ->
    if (metric.type !in byType) metric
    else {
      val value = byType[metric.type] ?: metric.currentValue
      metric.copy(
        currentValue = value,
        history =
          (metric.history + MetricDataPoint(update.timestamp, value, update.screenName)).takeLast(
            120,
          ),
        trend = calculateTrend(metric.currentValue, value),
      )
    }
  }
  val optionalTypes =
    setOf(MetricType.TouchLatency, MetricType.TimeToInteractive, MetricType.RecompositionCount)
  return updated +
    values
      .filter { it.first in optionalTypes && it.first !in existingTypes }
      .mapNotNull { (type, value) ->
        value?.let { liveMetric(type, it, update.timestamp, update.screenName) }
      }
}
