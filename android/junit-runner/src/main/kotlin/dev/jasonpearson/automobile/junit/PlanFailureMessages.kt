package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.UnhealthyDevice
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.DEVICE_UNHEALTHY_CODE
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

internal object PlanFailureMessages {
  internal fun unhealthyDevicesMessage(devices: List<UnhealthyDevice>): String =
    "Unhealthy devices: " +
      devices.joinToString(", ") {
        "${it.deviceId} (${it.reason}, ${if (it.recovering) "recovering" else "not recovering"})"
      }

  internal fun unhealthyFailureMessage(
    message: String,
    recovering: Boolean,
    devices: List<UnhealthyDevice>,
  ): String =
    "$DEVICE_UNHEALTHY_CODE: $message\n${unhealthyDevicesMessage(devices)}" +
      (if (!recovering) "\nReplace the device with killDevice then startDevice." else "")

  internal fun planFailureMessage(payload: JsonObject, isError: Boolean): String {
    val errorObject = payload["error"] as? JsonObject
    val failedStepObj = payload["failedStep"] as? JsonObject
    if (failedStepObj != null && errorObject == null && payload["code"] == null) {
      return failedStepMessage(payload, failedStepObj)
    }
    val daemonError = errorObject ?: payload
    val details =
      listOfNotNull(
        (daemonError["code"] as? JsonPrimitive)?.content,
        (daemonError["message"] as? JsonPrimitive)?.content,
        (daemonError["deviceId"] as? JsonPrimitive)?.content,
      )
    if (errorObject != null || payload.containsKey("code") || payload.containsKey("message")) {
      if (details.isNotEmpty()) return details.joinToString(": ")
    }

    return (payload["error"] as? JsonPrimitive)?.content
      ?: when {
        isError -> "Daemon tool returned an error: $payload"
        payload["success"] == JsonPrimitive(false) -> "AutoMobile plan failed"
        else -> "Daemon result did not confirm plan success: $payload"
      }
  }

  private fun failedStepMessage(payload: JsonObject, failedStepObj: JsonObject): String {
    val stepIndex = (failedStepObj["stepIndex"] as? JsonPrimitive)?.intOrNull ?: 0
    val tool = (failedStepObj["tool"] as? JsonPrimitive)?.content ?: "unknown"
    val stepError = (failedStepObj["error"] as? JsonPrimitive)?.content ?: "Unknown step error"
    val executedSteps = (payload["executedSteps"] as? JsonPrimitive)?.intOrNull
    val totalSteps = (payload["totalSteps"] as? JsonPrimitive)?.intOrNull
    return buildString {
      append("Test plan execution failed at step ${stepIndex + 1} ($tool):")
      append("\n  Error: $stepError")
      if (executedSteps != null && totalSteps != null) {
        append("\n  Executed: $executedSteps/$totalSteps steps")
      }
    }
  }
}
