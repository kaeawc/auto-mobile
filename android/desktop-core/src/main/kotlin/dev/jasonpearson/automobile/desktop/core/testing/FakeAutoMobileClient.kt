package dev.jasonpearson.automobile.desktop.core.testing

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ClearKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.ExecutePlanResult
import dev.jasonpearson.automobile.desktop.core.daemon.FeatureFlagState
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.KillDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.McpResource
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceTemplate
import dev.jasonpearson.automobile.desktop.core.daemon.McpTool
import dev.jasonpearson.automobile.desktop.core.daemon.ObserveResult
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult
import dev.jasonpearson.automobile.desktop.core.daemon.RemoveKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.SetActiveDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.SetKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.TestRecordingStartResult
import dev.jasonpearson.automobile.desktop.core.daemon.TestRecordingStopResult
import dev.jasonpearson.automobile.desktop.core.daemon.TestRunQuery
import dev.jasonpearson.automobile.desktop.core.daemon.TestRunSummary
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingQuery
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingSummary
import dev.jasonpearson.automobile.desktop.core.daemon.UpdateServiceResult
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Reusable fake implementation of [AutoMobileClient] for testing.
 *
 * All methods record their call name in [calls] and return configurable values. Resource responses
 * can be set per-URI via [setResourceResponseWithText].
 */
class FakeAutoMobileClient : AutoMobileClient {

  /** Ordered list of method names that were called. */
  val calls = mutableListOf<String>()

  // -- Configurable return values --

  override var transportName: String = "fake"
  override var connectionDescription: String = "Fake client for testing"

  var pingResult: () -> Unit = {}
  var listResourcesResult: List<McpResource> = emptyList()
  var listResourceTemplatesResult: List<McpResourceTemplate> = emptyList()
  var listToolsResult: List<McpTool> = emptyList()
  var getNavigationGraphResult: JsonElement = JsonObject(emptyMap())
  var listFeatureFlagsResult: List<FeatureFlagState> = emptyList()
  var setFeatureFlagResult: FeatureFlagState =
    FeatureFlagState(key = "", label = "", enabled = false)
  var listPerformanceAuditResultsResult: PerformanceAuditHistoryResult =
    PerformanceAuditHistoryResult()
  var getTestTimingsResult: TestTimingSummary = TestTimingSummary()
  var getTestRunsResult: TestRunSummary = TestRunSummary()
  var startTestRecordingResult: TestRecordingStartResult =
    TestRecordingStartResult(recordingId = "fake-id", startedAt = "2025-01-01T00:00:00Z")
  var stopTestRecordingResult: TestRecordingStopResult =
    TestRecordingStopResult(
      recordingId = "fake-id",
      startedAt = "2025-01-01T00:00:00Z",
      stoppedAt = "2025-01-01T00:00:01Z",
      durationMs = 1000,
      planName = "fake-plan",
      planContent = "",
      stepCount = 0,
    )
  var executePlanResult: ExecutePlanResult =
    ExecutePlanResult(success = true, executedSteps = 0, totalSteps = 0)
  var startDeviceResult: StartDeviceResult = StartDeviceResult(success = true)
  var setActiveDeviceResult: SetActiveDeviceResult = SetActiveDeviceResult(success = true)
  var observeResult: ObserveResult = ObserveResult()
  var killDeviceResult: KillDeviceResult = KillDeviceResult(success = true)
  var getDaemonStatusResult: DaemonStatusResponse = DaemonStatusResponse()
  var updateServiceResult: UpdateServiceResult = UpdateServiceResult(success = true)
  var inputTapResult: InputActionResult = InputActionResult(action = "input/tap", success = true)
  var inputSwipeResult: InputActionResult =
    InputActionResult(action = "input/swipe", success = true)
  var inputPressButtonResult: InputActionResult =
    InputActionResult(action = "input/pressButton", success = true)
  var inputTypeTextResult: InputActionResult =
    InputActionResult(action = "input/typeText", success = true)
  var inputKeyResult: InputActionResult = InputActionResult(action = "input/key", success = true)
  var setKeyValueResult: SetKeyValueResult = SetKeyValueResult(success = true)
  var removeKeyValueResult: RemoveKeyValueResult = RemoveKeyValueResult(success = true)
  var clearKeyValueFileResult: ClearKeyValueResult = ClearKeyValueResult(success = true)
  var callToolResult: JsonElement = JsonObject(emptyMap())
  var throwOnReadResource: Exception? = null

  // -- Resource response mapping --

  private val resourceResponses = mutableMapOf<String, List<McpResourceContent>>()

  /** Set a text resource response for a given URI. */
  fun setResourceResponseWithText(uri: String, text: String) {
    resourceResponses[uri] =
      listOf(McpResourceContent(uri = uri, mimeType = "application/json", text = text))
  }

  /** Set raw resource content for a given URI. */
  fun setResourceResponse(uri: String, contents: List<McpResourceContent>) {
    resourceResponses[uri] = contents
  }

  // -- Recorded write calls --

  data class SetKeyValueCall(
    val deviceId: String,
    val appId: String,
    val fileName: String,
    val key: String,
    val value: String?,
    val type: String,
    val platform: String = "android",
  )

  data class RemoveKeyValueCall(
    val deviceId: String,
    val appId: String,
    val fileName: String,
    val key: String,
    val platform: String = "android",
  )

  data class ClearKeyValueFileCall(
    val deviceId: String,
    val appId: String,
    val fileName: String,
    val platform: String = "android",
  )

  data class InputTapCall(
    val x: Double,
    val y: Double,
    val platform: String,
    val deviceId: String?,
    val duration: Int?,
    val frameContext: String? = null,
  )

  data class InputSwipeCall(
    val startX: Double,
    val startY: Double,
    val endX: Double,
    val endY: Double,
    val platform: String,
    val deviceId: String?,
    val durationMs: Int?,
    val frameContext: String? = null,
  )

  data class InputPressButtonCall(
    val button: String,
    val platform: String,
    val deviceId: String?,
    val frameContext: String? = null,
  )

  data class InputTypeTextCall(
    val text: String,
    val platform: String,
    val deviceId: String?,
    val submit: Boolean?,
    val append: Boolean = false,
    val frameContext: String? = null,
  )

  data class InputKeyCall(
    val key: String,
    val platform: String,
    val deviceId: String?,
    val frameContext: String? = null,
  )

  val setKeyValueCalls = mutableListOf<SetKeyValueCall>()
  val removeKeyValueCalls = mutableListOf<RemoveKeyValueCall>()
  val clearKeyValueFileCalls = mutableListOf<ClearKeyValueFileCall>()
  val inputTapCalls = mutableListOf<InputTapCall>()
  val inputSwipeCalls = mutableListOf<InputSwipeCall>()
  val inputPressButtonCalls = mutableListOf<InputPressButtonCall>()
  val inputTypeTextCalls = mutableListOf<InputTypeTextCall>()
  val inputKeyCalls = mutableListOf<InputKeyCall>()
  val toolCalls = mutableListOf<ToolCall>()

  data class ToolCall(val name: String, val arguments: JsonObject)

  // -- AutoMobileClient implementation --

  override fun ping() {
    calls.add("ping")
    pingResult()
  }

  override fun listResources(): List<McpResource> {
    calls.add("listResources")
    return listResourcesResult
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    calls.add("listResourceTemplates")
    return listResourceTemplatesResult
  }

  override fun listTools(): List<McpTool> {
    calls.add("listTools")
    return listToolsResult
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    calls.add("readResource")
    throwOnReadResource?.let { throw it }
    return resourceResponses[uri] ?: emptyList()
  }

  override fun getNavigationGraph(platform: String): JsonElement {
    calls.add("getNavigationGraph")
    return getNavigationGraphResult
  }

  override fun listFeatureFlags(): List<FeatureFlagState> {
    calls.add("listFeatureFlags")
    return listFeatureFlagsResult
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    calls.add("setFeatureFlag")
    return setFeatureFlagResult
  }

  override fun listPerformanceAuditResults(
    startTime: String?,
    endTime: String?,
    limit: Int?,
    offset: Int?,
  ): PerformanceAuditHistoryResult {
    calls.add("listPerformanceAuditResults")
    return listPerformanceAuditResultsResult
  }

  override fun getTestTimings(query: TestTimingQuery): TestTimingSummary {
    calls.add("getTestTimings")
    return getTestTimingsResult
  }

  override fun getTestRuns(query: TestRunQuery): TestRunSummary {
    calls.add("getTestRuns")
    return getTestRunsResult
  }

  override fun startTestRecording(platform: String): TestRecordingStartResult {
    calls.add("startTestRecording")
    return startTestRecordingResult
  }

  override fun stopTestRecording(recordingId: String?, planName: String?): TestRecordingStopResult {
    calls.add("stopTestRecording")
    return stopTestRecordingResult
  }

  override fun executePlan(
    planContent: String,
    platform: String,
    startStep: Int?,
    sessionUuid: String?,
  ): ExecutePlanResult {
    calls.add("executePlan")
    return executePlanResult
  }

  override fun startDevice(name: String, platform: String, deviceId: String?): StartDeviceResult {
    calls.add("startDevice")
    return startDeviceResult
  }

  override fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult {
    calls.add("setActiveDevice")
    return setActiveDeviceResult
  }

  override fun observe(platform: String): ObserveResult {
    calls.add("observe")
    return observeResult
  }

  override fun killDevice(name: String, deviceId: String, platform: String): KillDeviceResult {
    calls.add("killDevice")
    return killDeviceResult
  }

  override fun getDaemonStatus(): DaemonStatusResponse {
    calls.add("getDaemonStatus")
    return getDaemonStatusResult
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    calls.add("updateService")
    return updateServiceResult
  }

  override fun inputTap(
    x: Double,
    y: Double,
    platform: String,
    deviceId: String?,
    duration: Int?,
    frameContext: String?,
  ): InputActionResult {
    calls.add("inputTap")
    inputTapCalls.add(InputTapCall(x, y, platform, deviceId, duration, frameContext))
    return inputTapResult
  }

  override fun inputSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    platform: String,
    deviceId: String?,
    durationMs: Int?,
    frameContext: String?,
  ): InputActionResult {
    calls.add("inputSwipe")
    inputSwipeCalls.add(
      InputSwipeCall(startX, startY, endX, endY, platform, deviceId, durationMs, frameContext)
    )
    return inputSwipeResult
  }

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    calls.add("inputPressButton")
    inputPressButtonCalls.add(InputPressButtonCall(button, platform, deviceId, frameContext))
    return inputPressButtonResult
  }

  override fun inputTypeText(
    text: String,
    platform: String,
    deviceId: String?,
    submit: Boolean?,
    append: Boolean,
    frameContext: String?,
  ): InputActionResult {
    calls.add("inputTypeText")
    inputTypeTextCalls.add(
      InputTypeTextCall(text, platform, deviceId, submit, append, frameContext)
    )
    return inputTypeTextResult
  }

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    calls.add("inputKey")
    inputKeyCalls.add(InputKeyCall(key, platform, deviceId, frameContext))
    return inputKeyResult
  }

  override fun setKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
    platform: String,
  ): SetKeyValueResult {
    calls.add("setKeyValue")
    setKeyValueCalls.add(SetKeyValueCall(deviceId, appId, fileName, key, value, type, platform))
    return setKeyValueResult
  }

  override fun removeKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    platform: String,
  ): RemoveKeyValueResult {
    calls.add("removeKeyValue")
    removeKeyValueCalls.add(RemoveKeyValueCall(deviceId, appId, fileName, key, platform))
    return removeKeyValueResult
  }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
  ): ClearKeyValueResult {
    calls.add("clearKeyValueFile")
    clearKeyValueFileCalls.add(ClearKeyValueFileCall(deviceId, appId, fileName, platform))
    return clearKeyValueFileResult
  }

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    calls.add("callTool")
    toolCalls.add(ToolCall(name, arguments))
    return callToolResult
  }

  override fun close() {
    calls.add("close")
  }
}
