package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.serializer

internal class McpDaemonFeatureOperations(private val owner: () -> McpDaemonClient) :
  AutoMobileFeatureOperations {
  override fun listFeatureFlags(): List<FeatureFlagState> {
    with(owner()) {
      val response = sendRequest("ide/listFeatureFlags")
      val responseResult = ensureSuccess(response, "ide/listFeatureFlags")
      val result = json.decodeFromJsonElement(serializer<FeatureFlagListResult>(), responseResult)
      return result.flags
    }
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    with(owner()) {
      val response =
        sendRequest(
          "ide/setFeatureFlag",
          buildJsonObject {
            put("key", JsonPrimitive(key))
            put("enabled", JsonPrimitive(enabled))
            if (config != null) {
              put("config", config)
            }
          },
        )
      val responseResult = ensureSuccess(response, "ide/setFeatureFlag")
      return json.decodeFromJsonElement(serializer<FeatureFlagState>(), responseResult)
    }
  }

  override fun listPerformanceAuditResults(
    startTime: String?,
    endTime: String?,
    limit: Int?,
    offset: Int?,
    deviceId: String?,
  ): PerformanceAuditHistoryResult {
    with(owner()) {
      val uri = buildPerformanceResultsUri(startTime, endTime, limit, offset, deviceId)
      val contents = readResource(uri)
      return decodePerformanceAuditResource(json, contents)
    }
  }
}
