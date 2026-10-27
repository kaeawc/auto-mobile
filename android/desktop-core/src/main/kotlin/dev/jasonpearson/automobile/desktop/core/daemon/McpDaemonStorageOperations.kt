package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.serializer

internal class McpDaemonStorageOperations(private val owner: () -> McpDaemonClient) :
  AutoMobileStorageOperations {
  override fun setKeyValue(input: SetKeyValueRequest): SetKeyValueResult {
    with(owner()) {
      val deviceId = input.deviceId
      val appId = input.appId
      val fileName = input.fileName
      val key = input.key
      val value = input.value
      val type = input.type
      val platform = input.platform
      val sessionUuid = input.sessionUuid

      val response =
        sendRequest(
          "ide/setKeyValue",
          buildJsonObject {
            put("deviceId", JsonPrimitive(deviceId))
            put("platform", JsonPrimitive(platform))
            put("appId", JsonPrimitive(appId))
            put("fileName", JsonPrimitive(fileName))
            put("key", JsonPrimitive(key))
            put("value", if (value != null) JsonPrimitive(value) else JsonNull)
            put("type", JsonPrimitive(type))
            (sessionUuid ?: owner().sessionUuid)
              ?.takeIf { it.isNotBlank() }
              ?.let {
                put("sessionUuid", JsonPrimitive(it))
              }
          },
        )
      val responseResult = ensureSuccess(response, "ide/setKeyValue")
      return try {
        json.decodeFromJsonElement(serializer<SetKeyValueResult>(), responseResult)
      } catch (e: IllegalArgumentException) {
        SetKeyValueResult(success = false, message = e.message ?: "Failed to set key value")
      }
    }
  }

  override fun removeKeyValue(input: RemoveKeyValueRequest): RemoveKeyValueResult {
    with(owner()) {
      val deviceId = input.deviceId
      val appId = input.appId
      val fileName = input.fileName
      val key = input.key
      val platform = input.platform
      val sessionUuid = input.sessionUuid

      val response =
        sendRequest(
          "ide/removeKeyValue",
          buildJsonObject {
            put("deviceId", JsonPrimitive(deviceId))
            put("platform", JsonPrimitive(platform))
            put("appId", JsonPrimitive(appId))
            put("fileName", JsonPrimitive(fileName))
            put("key", JsonPrimitive(key))
            (sessionUuid ?: owner().sessionUuid)
              ?.takeIf { it.isNotBlank() }
              ?.let {
                put("sessionUuid", JsonPrimitive(it))
              }
          },
        )
      val responseResult = ensureSuccess(response, "ide/removeKeyValue")
      return try {
        json.decodeFromJsonElement(serializer<RemoveKeyValueResult>(), responseResult)
      } catch (e: IllegalArgumentException) {
        RemoveKeyValueResult(success = false, message = e.message ?: "Failed to remove key value")
      }
    }
  }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
    sessionUuid: String?,
  ): ClearKeyValueResult {
    with(owner()) {
      val response =
        sendRequest(
          "ide/clearKeyValueFile",
          buildJsonObject {
            put("deviceId", JsonPrimitive(deviceId))
            put("platform", JsonPrimitive(platform))
            put("appId", JsonPrimitive(appId))
            put("fileName", JsonPrimitive(fileName))
            (sessionUuid ?: owner().sessionUuid)
              ?.takeIf { it.isNotBlank() }
              ?.let {
                put("sessionUuid", JsonPrimitive(it))
              }
          },
        )
      val responseResult = ensureSuccess(response, "ide/clearKeyValueFile")
      return try {
        json.decodeFromJsonElement(serializer<ClearKeyValueResult>(), responseResult)
      } catch (e: IllegalArgumentException) {
        ClearKeyValueResult(
          success = false,
          message = e.message ?: "Failed to clear key value file",
        )
      }
    }
  }
}
