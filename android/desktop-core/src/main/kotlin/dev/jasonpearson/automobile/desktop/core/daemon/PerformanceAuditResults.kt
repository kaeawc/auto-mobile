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
  /** Device epoch the audit ran against; null for audits recorded before daemons stamped it. */
  val deviceSessionUuid: String? = null,
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

/** Filters for the performance-results resource; null fields are omitted from the URI. */
data class PerformanceAuditQuery(
  val startTime: String? = null,
  val endTime: String? = null,
  val limit: Int? = null,
  val offset: Int? = null,
  val deviceId: String? = null,
  /**
   * Only audits stamped with this device epoch. A daemon that predates the filter rejects it as an
   * unknown query parameter ([isUnknownDeviceSessionUuidFilter]).
   */
  val deviceSessionUuid: String? = null,
)

internal fun PerformanceAuditQuery.toResourceUri(): String {
  return ResourceUriBuilder(PERFORMANCE_RESULTS_RESOURCE_URI)
    .apply {
      add("startTime", startTime)
      add("endTime", endTime)
      add("limit", limit)
      add("offset", offset)
      add("deviceId", deviceId)
      add("deviceSessionUuid", deviceSessionUuid)
    }
    .build()
}

/**
 * Whether [this] is a daemon that predates the `deviceSessionUuid` filter rejecting it: its
 * performance-results resource fails closed on any query key it does not know.
 */
fun McpConnectionException.isUnknownDeviceSessionUuidFilter(): Boolean {
  val text = message ?: return false
  return text.contains("Unknown query parameters") && text.contains("deviceSessionUuid")
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
