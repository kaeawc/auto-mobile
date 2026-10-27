package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

abstract class StdioResourceOperations : AutoMobileClient {
  protected abstract val json: Json

  override fun getNavigationGraph(platform: String): JsonElement {
    val response =
      callTool(
        "getNavigationGraph",
        buildJsonObject { put("platform", JsonPrimitive(platform)) },
      )
    return response
  }

  override fun listFeatureFlags(): List<FeatureFlagState> {
    val response = callTool("listFeatureFlags", JsonObject(emptyMap()))
    val result = decodeToolResponse(json, response, serializer<FeatureFlagListResult>())
    return result.flags
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    val response =
      callTool(
        "setFeatureFlag",
        buildJsonObject {
          put("key", JsonPrimitive(key))
          put("enabled", JsonPrimitive(enabled))
          if (config != null) {
            put("config", config)
          }
        },
      )
    return decodeToolResponse(json, response, serializer<FeatureFlagState>())
  }

  override fun listPerformanceAuditResults(
    startTime: String?,
    endTime: String?,
    limit: Int?,
    offset: Int?,
    deviceId: String?,
  ): PerformanceAuditHistoryResult {
    val uri = buildPerformanceResultsUri(startTime, endTime, limit, offset, deviceId)
    val contents = readResource(uri)
    return decodePerformanceAuditResource(json, contents)
  }

  override fun getTestTimings(query: TestTimingQuery): TestTimingSummary {
    val contents = readResource(query.toResourceUri())
    return decodeResourceResponse(json, contents, serializer<TestTimingSummary>())
  }

  override fun getTestRuns(query: TestRunQuery): TestRunSummary {
    val contents = readResource(query.toResourceUri())
    return decodeResourceResponse(json, contents, serializer<TestRunSummary>())
  }
}
