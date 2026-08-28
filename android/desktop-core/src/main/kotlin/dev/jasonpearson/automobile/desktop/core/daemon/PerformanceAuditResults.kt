package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

@Serializable
data class PerformanceAuditMetrics(
  val p50Ms: Double? = null,
  val p90Ms: Double? = null,
  val p95Ms: Double? = null,
  val p99Ms: Double? = null,
  val jankCount: Int? = null,
  val missedVsyncCount: Int? = null,
  val slowUiThreadCount: Int? = null,
  val frameDeadlineMissedCount: Int? = null,
  val cpuUsagePercent: Double? = null,
  val touchLatencyMs: Double? = null,
)

@Serializable
data class PerformanceAuditHistoryEntry(
  val id: Long,
  val deviceId: String,
  val sessionId: String,
  val packageName: String,
  val timestamp: String,
  val passed: Boolean,
  val metrics: PerformanceAuditMetrics,
  val diagnostics: String? = null,
)

@Serializable
data class PerformanceAuditHistoryRange(
  val startTime: String,
  val endTime: String,
)

@Serializable
data class PerformanceAuditHistoryResult(
  val results: List<PerformanceAuditHistoryEntry> = emptyList(),
  val toolCalls: List<String> = emptyList(),
  val hasMore: Boolean = false,
  val nextOffset: Int? = null,
  val range: PerformanceAuditHistoryRange? = null,
)

internal const val PERFORMANCE_RESULTS_RESOURCE_URI = "automobile:performance-results"

internal fun buildPerformanceResultsUri(
  startTime: String?,
  endTime: String?,
  limit: Int?,
  offset: Int?,
  deviceId: String?,
): String {
  return ResourceUriBuilder(PERFORMANCE_RESULTS_RESOURCE_URI)
    .apply {
      add("startTime", startTime)
      add("endTime", endTime)
      add("limit", limit)
      add("offset", offset)
      add("deviceId", deviceId)
    }
    .build()
}

internal fun decodePerformanceAuditResource(
  json: Json,
  contents: List<McpResourceContent>,
): PerformanceAuditHistoryResult {
  val payload = contents.firstOrNull()?.text?.trim().orEmpty()
  if (payload.isBlank()) {
    throw McpConnectionException("Performance resource returned no data.")
  }

  val jsonElement = json.parseToJsonElement(payload)
  if (jsonElement is JsonObject) {
    val errorMessage = jsonElement["error"]?.jsonPrimitive?.contentOrNull
    if (!errorMessage.isNullOrBlank()) {
      throw McpConnectionException(errorMessage)
    }
  }

  return json.decodeFromJsonElement(serializer<PerformanceAuditHistoryResult>(), jsonElement)
}
