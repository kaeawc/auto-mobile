package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal class McpHttpStorageOperations(private val transport: McpHttpTransport) :
  AutoMobileStorageOperations {
  private val json = transport.json
  private val resources = McpHttpResources(transport)

  override fun setKeyValue(input: SetKeyValueRequest): SetKeyValueResult {
    val deviceId = input.deviceId
    val appId = input.appId
    val fileName = input.fileName
    val key = input.key
    val value = input.value
    val type = input.type
    val platform = input.platform
    val sessionUuid = input.sessionUuid

    val response =
      transport.callTool(
        "setKeyValue",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
          put("key", JsonPrimitive(key))
          put("value", if (value != null) JsonPrimitive(value) else JsonNull)
          put("type", JsonPrimitive(type))
          sessionUuid?.takeIf { it.isNotBlank() }?.let { put("sessionUuid", JsonPrimitive(it)) }
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<SetKeyValueResult>())
    } catch (e: SerializationException) {
      SetKeyValueResult(success = false, message = e.message ?: "Failed to set key value")
    } catch (e: McpConnectionException) {
      SetKeyValueResult(success = false, message = e.message ?: "Failed to set key value")
    }
  }

  override fun removeKeyValue(input: RemoveKeyValueRequest): RemoveKeyValueResult {
    val deviceId = input.deviceId
    val appId = input.appId
    val fileName = input.fileName
    val key = input.key
    val platform = input.platform
    val sessionUuid = input.sessionUuid

    val response =
      transport.callTool(
        "removeKeyValue",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
          put("key", JsonPrimitive(key))
          sessionUuid?.takeIf { it.isNotBlank() }?.let { put("sessionUuid", JsonPrimitive(it)) }
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<RemoveKeyValueResult>())
    } catch (e: SerializationException) {
      RemoveKeyValueResult(success = false, message = e.message ?: "Failed to remove key value")
    } catch (e: McpConnectionException) {
      RemoveKeyValueResult(success = false, message = e.message ?: "Failed to remove key value")
    }
  }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
    sessionUuid: String?,
  ): ClearKeyValueResult {
    val response =
      transport.callTool(
        "clearKeyValueFile",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
          sessionUuid?.takeIf { it.isNotBlank() }?.let { put("sessionUuid", JsonPrimitive(it)) }
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<ClearKeyValueResult>())
    } catch (e: SerializationException) {
      ClearKeyValueResult(success = false, message = e.message ?: "Failed to clear key value file")
    } catch (e: McpConnectionException) {
      ClearKeyValueResult(success = false, message = e.message ?: "Failed to clear key value file")
    }
  }
}
