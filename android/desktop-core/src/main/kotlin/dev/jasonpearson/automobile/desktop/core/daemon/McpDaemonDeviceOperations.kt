package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.serializer

internal class McpDaemonDeviceOperations(private val owner: () -> McpDaemonClient) :
  AutoMobileDeviceOperations {
  override fun getNavigationGraph(platform: String): JsonElement {
    with(owner()) {
      val response =
        sendRequest(
          "ide/getNavigationGraph",
          buildJsonObject { put("platform", JsonPrimitive(platform)) },
        )
      ensureSuccess(response)
      return response.result ?: JsonObject(emptyMap())
    }
  }

  override fun startDevice(name: String, platform: String, deviceId: String?): StartDeviceResult {
    with(owner()) {
      val response =
        callTool(
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
      } catch (e: McpConnectionException) {
        startDeviceFailure(e)
      } catch (e: IllegalArgumentException) {
        startDeviceFailure(e)
      }
    }
  }

  override fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult {
    with(owner()) {
      val response =
        callTool(
          "setActiveDevice",
          buildJsonObject {
            put("deviceId", JsonPrimitive(deviceId))
            put("platform", JsonPrimitive(platform))
          },
        )
      return try {
        decodeToolResponse(json, response, serializer<SetActiveDeviceResult>())
      } catch (e: McpConnectionException) {
        SetActiveDeviceResult(
          success = false,
          message = e.message ?: "Failed to set active device",
          refusal = classifySetActiveDeviceRefusal(json, response),
        )
      } catch (e: IllegalArgumentException) {
        SetActiveDeviceResult(
          success = false,
          message = e.message ?: "Failed to set active device",
          refusal = classifySetActiveDeviceRefusal(json, response),
        )
      }
    }
  }

  override fun observe(platform: String): ObserveResult {
    with(owner()) {
      val response =
        callTool(
          "observe",
          buildJsonObject {
            put("platform", JsonPrimitive(platform))
          },
        )
      return decodeObserveResponse(json, response)
    }
  }

  override fun killDevice(
    name: String,
    deviceId: String,
    platform: String,
    force: Boolean,
  ): KillDeviceResult {
    with(owner()) {
      val response = callTool("killDevice", killDeviceArguments(name, deviceId, platform, force))
      return decodeKillDeviceResponse(json, response)
    }
  }

  override fun getDaemonStatus():
    dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse {
    with(owner()) {

      // Hang ceiling on the status probe (#4858). The blocking SocketChannel read is not
      // cancellable
      // by coroutine cancellation, so a wrapping withTimeout at the caller cannot unblock a daemon
      // that accepts but never replies — only this watchdog, which closes the socket, can. A
      // healthy
      // ide/status round-trip is ~ms, so a deadline here bounds the connectivity dot without
      // risking
      // a
      // slow ordinary tool call (those stay unbounded; see [sendRequest]).
      val response =
        sendRequest(
          "ide/status",
          timeoutMs = statusRequestTimeoutMs,
          skipLifecyclePreflight = true,
        )
      val responseResult = ensureSuccess(response, "ide/status")
      return json.decodeFromJsonElement(
        serializer<dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse>(),
        responseResult,
      )
    }
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    with(owner()) {
      val response =
        sendRequest(
          "ide/updateService",
          buildJsonObject {
            put("deviceId", JsonPrimitive(deviceId))
            put("platform", JsonPrimitive(platform))
          },
        )
      val responseResult = ensureSuccess(response, "ide/updateService")
      return json.decodeFromJsonElement(serializer<UpdateServiceResult>(), responseResult)
    }
  }
}
