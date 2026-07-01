package dev.jasonpearson.automobile.desktop.domain

public enum class FailureType(public val label: String, public val icon: String) {
  Crash("Crash", "\uD83D\uDCA5"),
  ANR("ANR", "\uD83D\uDD04"),
  ToolCallFailure("Tool Failure", "\uD83D\uDD27"),
  NonFatal("Non-Fatal", "\u26A0\uFE0F"),
}

public enum class FailureSeverity(public val label: String) {
  Critical("Critical"),
  High("High"),
  Medium("Medium"),
  Low("Low"),
}

public data class StackTraceElement(
  val className: String,
  val methodName: String,
  val fileName: String?,
  val lineNumber: Int?,
  val isAppCode: Boolean = false,
)

public data class DeviceBreakdown(
  val deviceModel: String,
  val os: String,
  val count: Int,
  val percentage: Float,
)

public data class VersionBreakdown(
  val version: String,
  val count: Int,
  val percentage: Float,
)

public data class ScreenBreakdown(
  val screenName: String,
  val visitCount: Int,
  val failureCount: Int,
  val visitPercentage: Float,
)

public data class DurationStats(
  val minMs: Long,
  val maxMs: Long,
  val avgMs: Long,
  val medianMs: Long,
  val p95Ms: Long,
)

public data class AggregatedToolCallInfo(
  val toolName: String,
  val errorCodes: Map<String, Int>,
  val parameterVariants: Map<String, List<String>>,
  val durationStats: DurationStats?,
)

public data class FailureCapture(
  val id: String,
  val type: CaptureType,
  val path: String,
  val timestamp: Long,
  val deviceModel: String,
)

public enum class CaptureType {
  Screenshot,
  Video,
}

public data class FailureOccurrence(
  val id: String,
  val timestamp: Long,
  val deviceModel: String,
  val os: String,
  val appVersion: String,
  val sessionId: String,
  val screenAtFailure: String?,
  val screensVisited: List<String>,
  val testName: String?,
  val capturePath: String?,
  val captureType: CaptureType?,
)

public data class FailureGroup(
  val id: String,
  val type: FailureType,
  val signature: String,
  val title: String,
  val message: String,
  val firstOccurrence: Long,
  val lastOccurrence: Long,
  val totalCount: Int,
  val uniqueSessions: Int,
  val severity: FailureSeverity,
  val deviceBreakdown: List<DeviceBreakdown>,
  val versionBreakdown: List<VersionBreakdown>,
  val screenBreakdown: List<ScreenBreakdown>,
  val failureScreens: Map<String, Int>,
  val stackTraceElements: List<StackTraceElement>,
  val toolCallInfo: AggregatedToolCallInfo?,
  val affectedTests: Map<String, Int>,
  val recentCaptures: List<FailureCapture>,
  val sampleOccurrences: List<FailureOccurrence>,
)

public data class TimelineData(
  val dataPoints: List<TimelineDataPoint>,
  val previousPeriodTotals: PeriodTotals,
)

public data class TimelineDataPoint(
  val label: String,
  val crashes: Int,
  val anrs: Int,
  val toolFailures: Int,
  val nonfatals: Int = 0,
) {
  public val total: Int
    get() = crashes + anrs + toolFailures + nonfatals
}

public data class PeriodTotals(
  val crashes: Int,
  val anrs: Int,
  val toolFailures: Int,
  val nonfatals: Int = 0,
)

public enum class DateRange(public val label: String, public val durationMs: Long) {
  OneHour("1h", 60 * 60 * 1000L),
  TwentyFourHours("24h", 24 * 60 * 60 * 1000L),
  ThreeDays("3d", 3 * 24 * 60 * 60 * 1000L),
  SevenDays("7d", 7 * 24 * 60 * 60 * 1000L),
  ThirtyDays("30d", 30 * 24 * 60 * 60 * 1000L);

  public fun toQueryParam(): String = label
}

public enum class TimeAggregation(public val label: String, public val durationMs: Long) {
  Minute("Min", 60 * 1000L),
  Hour("Hour", 60 * 60 * 1000L),
  Day("Day", 24 * 60 * 60 * 1000L),
  Week("Week", 7 * 24 * 60 * 60 * 1000L);

  public fun toQueryParam(): String = name.lowercase()
}
