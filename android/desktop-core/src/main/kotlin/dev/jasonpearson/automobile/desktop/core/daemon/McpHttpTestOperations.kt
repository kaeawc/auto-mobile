package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal class McpHttpTestOperations(private val transport: McpHttpTransport) :
  AutoMobileTestOperations {
  private val json = transport.json
  private val resources = McpHttpResources(transport)
  private val deviceGestureRecordingClient = DeviceGestureRecordingSocketClient()

  override fun getTestTimings(query: TestTimingQuery): TestTimingSummary {
    val contents = resources.readResource(query.toResourceUri())
    return decodeResourceResponse(json, contents, serializer<TestTimingSummary>())
  }

  override fun getTestRuns(query: TestRunQuery): TestRunSummary {
    val contents = resources.readResource(query.toResourceUri())
    return decodeResourceResponse(json, contents, serializer<TestRunSummary>())
  }

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
      transport.callTool(
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
