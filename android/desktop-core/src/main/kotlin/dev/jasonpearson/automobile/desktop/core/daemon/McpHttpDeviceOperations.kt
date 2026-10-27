package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal class McpHttpDeviceOperations(private val transport: McpHttpTransport) :
  AutoMobileDeviceOperations {
  private val json = transport.json
  private val resources = McpHttpResources(transport)
  private val statusRequestTimeoutMs = transport.options.statusRequestTimeoutMs
  private val statusDeadlineFactory = transport.options.statusDeadlineFactory

  override fun getNavigationGraph(platform: String): JsonElement {
    val response =
      transport.callTool(
        "getNavigationGraph",
        buildJsonObject { put("platform", JsonPrimitive(platform)) },
      )
    return response
  }

  override fun startDevice(name: String, platform: String, deviceId: String?): StartDeviceResult {
    val response =
      transport.callTool(
        "startDevice",
        buildJsonObject {
          put(
            "device",
            buildJsonObject {
              put("name", JsonPrimitive(name))
              put("platform", JsonPrimitive(platform))
              if (deviceId != null) {
                put("deviceId", JsonPrimitive(deviceId))
              }
            },
          )
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<StartDeviceResult>())
    } catch (e: SerializationException) {
      startDeviceFailure(e)
    } catch (e: McpConnectionException) {
      startDeviceFailure(e)
    }
  }

  override fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult {
    val response =
      transport.callTool(
        "setActiveDevice",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<SetActiveDeviceResult>())
    } catch (e: SerializationException) {
      SetActiveDeviceResult(success = false, message = e.message ?: "Failed to set active device")
    } catch (e: McpConnectionException) {
      SetActiveDeviceResult(success = false, message = e.message ?: "Failed to set active device")
    }
  }

  override fun observe(platform: String): ObserveResult {
    val response =
      transport.callTool(
        "observe",
        buildJsonObject {
          put("platform", JsonPrimitive(platform))
        },
      )
    return decodeObserveResponse(json, response)
  }

  override fun killDevice(
    name: String,
    deviceId: String,
    platform: String,
    force: Boolean,
  ): KillDeviceResult {
    val response =
      transport.callTool("killDevice", killDeviceArguments(name, deviceId, platform, force))
    return decodeKillDeviceResponse(json, response)
  }

  override fun getDaemonStatus():
    dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse {
    val deadline = statusDeadlineFactory(statusRequestTimeoutMs)
    val response =
      transport.callToolWithTimeout(
        "getDaemonStatus",
        JsonObject(emptyMap()),
        deadline,
      )
    return try {
      decodeToolResponse(
        json,
        response,
        serializer<dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse>(),
      )
    } catch (e: SerializationException) {
      dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("McpHttpClient")
        .warn("Invalid daemon status response", e)
      dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse()
    } catch (e: McpConnectionException) {
      dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("McpHttpClient")
        .warn("Invalid daemon status response", e)
      dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse()
    }
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    val response =
      transport.callTool(
        "updateService",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<UpdateServiceResult>())
    } catch (e: SerializationException) {
      UpdateServiceResult(success = false, message = e.message ?: "Failed to update service")
    } catch (e: McpConnectionException) {
      UpdateServiceResult(success = false, message = e.message ?: "Failed to update service")
    }
  }
}
