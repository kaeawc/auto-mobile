package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.serializer

internal class McpDaemonTestOperations(private val owner: () -> McpDaemonClient) :
  AutoMobileTestOperations {
  override fun getTestTimings(query: TestTimingQuery): TestTimingSummary {
    with(owner()) {
      val contents = readResource(query.toResourceUri())
      return decodeResourceResponse(json, contents, serializer<TestTimingSummary>())
    }
  }

  override fun getTestRuns(query: TestRunQuery): TestRunSummary {
    with(owner()) {
      val contents = readResource(query.toResourceUri())
      return decodeResourceResponse(json, contents, serializer<TestRunSummary>())
    }
  }

  override fun startDeviceGestureRecording(platform: String): DeviceGestureRecordingStartResult {
    with(owner()) {
      return deviceGestureRecordingClient.startDeviceGestureRecording(platform)
    }
  }

  override fun stopDeviceGestureRecording(
    recordingId: String?,
    planName: String?,
  ): DeviceGestureRecordingStopResult {
    with(owner()) {
      val resolvedPlanName = planName?.ifBlank { null }
      return deviceGestureRecordingClient.stopDeviceGestureRecording(recordingId, resolvedPlanName)
    }
  }

  override fun executePlan(
    planContent: String,
    platform: String,
    startStep: Int?,
    sessionUuid: String?,
  ): ExecutePlanResult {
    with(owner()) {
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
  }
}
