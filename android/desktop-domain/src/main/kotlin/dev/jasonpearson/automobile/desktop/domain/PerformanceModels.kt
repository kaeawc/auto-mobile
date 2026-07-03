package dev.jasonpearson.automobile.desktop.domain

public enum class HealthStatus {
  Healthy,
  Warning,
  Critical,
}

public enum class MetricType {
  TouchLatency,
  TimeToFirstFrame,
  TimeToInteractive,
  Jank,
  FPS,
  FrameTime,
  Memory,
  RecompositionCount,
}

public data class PerformanceMetric(
  val id: String,
  val type: MetricType,
  val name: String,
  val currentValue: Float,
  val unit: String,
  val thresholdWarning: Float,
  val thresholdCritical: Float,
  val trend: MetricTrend,
  val history: List<MetricDataPoint>,
)

public enum class MetricTrend {
  Up,
  Down,
  Stable,
}

public data class MetricDataPoint(
  val timestamp: Long,
  val value: Float,
  val screenName: String? = null,
  val testStep: String? = null,
)

public data class PerformanceAnomaly(
  val id: String,
  val metricType: MetricType,
  val severity: HealthStatus,
  val message: String,
  val timestamp: Long,
  val screenName: String?,
  val testName: String?,
  val value: Float,
  val threshold: Float,
  val isPinned: Boolean = false,
)

public data class PerformanceRun(
  val id: String,
  val name: String,
  val timestamp: Long,
  val durationMs: Int,
  val deviceName: String,
  val overallHealth: HealthStatus,
  val metrics: List<PerformanceMetric>,
  val anomalies: List<PerformanceAnomaly>,
  val screensAnalyzed: List<String>,
)

public data class RunComparison(
  val baselineRun: PerformanceRun,
  val compareRun: PerformanceRun,
  val improvements: List<MetricChange>,
  val regressions: List<MetricChange>,
)

public data class MetricChange(
  val metricType: MetricType,
  val baselineValue: Float,
  val compareValue: Float,
  val percentChange: Float,
)

public object PerformanceThresholds {
  public const val FPS_WARNING: Float = 55f
  public const val FPS_CRITICAL: Float = 45f
  public const val FRAME_TIME_WARNING_MS: Float = 18f
  public const val FRAME_TIME_CRITICAL_MS: Float = 33f
  public const val JANK_WARNING_FRAMES: Float = 5f
  public const val JANK_CRITICAL_FRAMES: Float = 10f
  public const val TOUCH_LATENCY_WARNING_MS: Float = 100f
  public const val TOUCH_LATENCY_CRITICAL_MS: Float = 200f
  public const val TTFF_WARNING_MS: Float = 500f
  public const val TTFF_CRITICAL_MS: Float = 1000f
  public const val TTI_WARNING_MS: Float = 700f
  public const val TTI_CRITICAL_MS: Float = 1500f
  public const val MEMORY_WARNING_MB: Float = 256f
  public const val MEMORY_CRITICAL_MB: Float = 512f
  public const val CPU_WARNING_PERCENT: Float = 50f
  public const val CPU_CRITICAL_PERCENT: Float = 80f
  public const val RECOMPOSITION_WARNING: Float = 10f
  public const val RECOMPOSITION_CRITICAL: Float = 50f
}
