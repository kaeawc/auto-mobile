package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal class McpHttpFeatureOperations(private val transport: McpHttpTransport) :
  AutoMobileFeatureOperations {
  private val json = transport.json
  private val resources = McpHttpResources(transport)

  override fun listFeatureFlags(): List<FeatureFlagState> {
    val response = transport.callTool("listFeatureFlags", JsonObject(emptyMap()))
    val result = decodeToolResponse(json, response, serializer<FeatureFlagListResult>())
    return result.flags
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    val response =
      transport.callTool(
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
    val contents = resources.readResource(uri)
    return decodePerformanceAuditResource(json, contents)
  }
}
