package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

abstract class StdioDeviceOperations : StdioResourceOperations() {
  private val deviceGestureRecordingClient = DeviceGestureRecordingSocketClient()

  override fun startDeviceGestureRecording(platform: String): DeviceGestureRecordingStartResult {
    return deviceGestureRecordingClient.startDeviceGestureRecording(platform)
  }

  override fun stopDeviceGestureRecording(
    recordingId: String?,
    planName: String?,
  ): DeviceGestureRecordingStopResult {
    val resolvedPlanName = planName?.ifBlank { null }
    return deviceGestureRecordingClient.stopDeviceGestureRecording(recordingId, resolvedPlanName)
  }

  override fun executePlan(
    planContent: String,
    platform: String,
    startStep: Int?,
    sessionUuid: String?,
  ): ExecutePlanResult {
    val response =
      callTool(
        "executePlan",
        buildJsonObject {
          put("planContent", JsonPrimitive(planContent))
          put("platform", JsonPrimitive(platform))
          if (startStep != null) {
            put("startStep", JsonPrimitive(startStep))
          }
          if (!sessionUuid.isNullOrBlank()) {
            put("sessionUuid", JsonPrimitive(sessionUuid))
          }
        },
      )
    return decodeToolResponse(json, response, serializer<ExecutePlanResult>())
  }

  override fun startDevice(name: String, platform: String, deviceId: String?): StartDeviceResult {
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
    } catch (e: IllegalArgumentException) {
      startDeviceFailure(e)
    } catch (e: McpConnectionException) {
      startDeviceFailure(e)
    }
  }

  override fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult {
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
    } catch (e: IllegalArgumentException) {
      SetActiveDeviceResult(success = false, message = e.message ?: "Failed to set active device")
    } catch (e: McpConnectionException) {
      SetActiveDeviceResult(success = false, message = e.message ?: "Failed to set active device")
    }
  }

  override fun observe(platform: String): ObserveResult {
    val response =
      callTool(
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
    val response = callTool("killDevice", killDeviceArguments(name, deviceId, platform, force))
    return decodeKillDeviceResponse(json, response)
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    val response =
      callTool(
        "updateService",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<UpdateServiceResult>())
    } catch (e: IllegalArgumentException) {
      UpdateServiceResult(success = false, message = e.message ?: "Failed to update service")
    } catch (e: McpConnectionException) {
      UpdateServiceResult(success = false, message = e.message ?: "Failed to update service")
    }
  }
}
