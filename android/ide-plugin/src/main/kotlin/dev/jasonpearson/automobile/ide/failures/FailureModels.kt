package dev.jasonpearson.automobile.ide.failures

import androidx.compose.ui.graphics.Color

/**
 * Types of failures that can occur
 */
enum class FailureType(val label: String, val icon: String, val color: Color) {
    Crash("Crash", "💥", Color(0xFFE53935)),
    ANR("ANR", "🔄", Color(0xFFFF9800)),
    ToolCallFailure("Tool Failure", "🔧", Color(0xFF9C27B0)),
}

/**
 * Severity of a failure based on frequency and impact
 */
enum class FailureSeverity(val label: String, val color: Color) {
    Critical("Critical", Color(0xFFE53935)),
    High("High", Color(0xFFFF5722)),
    Medium("Medium", Color(0xFFFF9800)),
    Low("Low", Color(0xFFFFC107)),
}

/**
 * A failure event (crash, ANR, or tool call failure)
 */
data class FailureEvent(
    val id: String,
    val type: FailureType,
    val title: String,
    val message: String,
    val stackTrace: String?,
    val stackTraceElements: List<StackTraceElement> = emptyList(),
    val timestamp: Long,
    val screenAtFailure: String?,
    val screensVisited: List<String>,
    val relatedTestName: String?,
    val deviceInfo: DeviceInfo,
    val occurrenceCount: Int = 1,
    val severity: FailureSeverity = FailureSeverity.Medium,
    val toolCallInfo: ToolCallInfo? = null,
    val screenshotPath: String? = null,
    val videoPath: String? = null,
)

/**
 * Parsed stack trace element with file navigation info
 */
data class StackTraceElement(
    val className: String,
    val methodName: String,
    val fileName: String?,
    val lineNumber: Int?,
    val isAppCode: Boolean = false, // true if this is user's app code (not framework)
)

/**
 * Device information at time of failure
 */
data class DeviceInfo(
    val name: String,
    val os: String,
    val appVersion: String,
    val memoryUsage: String? = null,
    val cpuUsage: String? = null,
)

/**
 * Tool call specific information for AutoMobile tool failures
 */
data class ToolCallInfo(
    val toolName: String,
    val parameters: Map<String, String>,
    val errorCode: String?,
    val duration: Long?,
)

/**
 * Group of similar failures for aggregation
 */
data class FailureGroup(
    val id: String,
    val type: FailureType,
    val signature: String,
    val title: String,
    val firstOccurrence: Long,
    val lastOccurrence: Long,
    val totalCount: Int,
    val affectedTests: List<String>,
    val severity: FailureSeverity,
    val representativeEvent: FailureEvent,
)
