package dev.jasonpearson.automobile.desktop.core.testing

import dev.jasonpearson.automobile.desktop.core.daemon.ClearKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceGestureRecordingStartResult
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceGestureRecordingStopResult
import dev.jasonpearson.automobile.desktop.core.daemon.ExecutePlanResult
import dev.jasonpearson.automobile.desktop.core.daemon.FeatureFlagState
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.KillDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.McpResource
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceTemplate
import dev.jasonpearson.automobile.desktop.core.daemon.McpTool
import dev.jasonpearson.automobile.desktop.core.daemon.ObserveResult
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult
import dev.jasonpearson.automobile.desktop.core.daemon.RemoveKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.SetActiveDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.SetKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.TestRunSummary
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingSummary
import dev.jasonpearson.automobile.desktop.core.daemon.UpdateServiceResult
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.ClearKeyValueFileCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputKeyCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputPressButtonCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputSwipeCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputTapCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputTypeTextCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.RecordingGestureStream
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.RemoveKeyValueCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.SetKeyValueCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.ToolCall
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

internal class FakeAutoMobileClientState {
  val calls = mutableListOf<String>()
  var transportName: String = "fake"
  var connectionDescription: String = "Fake client for testing"
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
  var startDeviceGestureRecordingResult: DeviceGestureRecordingStartResult =
    DeviceGestureRecordingStartResult(recordingId = "fake-id", startedAt = "2025-01-01T00:00:00Z")
  var stopDeviceGestureRecordingResult: DeviceGestureRecordingStopResult =
    DeviceGestureRecordingStopResult(
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
  val queuedStartDeviceResults: ArrayDeque<StartDeviceResult> = ArrayDeque()
  var setActiveDeviceResult: SetActiveDeviceResult = SetActiveDeviceResult(success = true)
  var observeResult: ObserveResult = ObserveResult()
  var observeError: Throwable? = null
  var killDeviceResult: KillDeviceResult = KillDeviceResult(success = true)
  val killDeviceForceRequests: MutableList<Boolean> = mutableListOf()
  var getDaemonStatusResult: DaemonStatusResponse = DaemonStatusResponse()
  var getDaemonStatusError: Throwable? = null
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
  var onKeyValueMutation: (() -> Unit)? = null
  var callToolResult: JsonElement = JsonObject(emptyMap())
  var throwOnReadResource: Exception? = null
  val setKeyValueCalls = mutableListOf<SetKeyValueCall>()
  val removeKeyValueCalls = mutableListOf<RemoveKeyValueCall>()
  val clearKeyValueFileCalls = mutableListOf<ClearKeyValueFileCall>()
  val inputTapCalls = mutableListOf<InputTapCall>()
  val inputSwipeCalls = mutableListOf<InputSwipeCall>()
  val inputPressButtonCalls = mutableListOf<InputPressButtonCall>()
  val inputTypeTextCalls = mutableListOf<InputTypeTextCall>()
  val inputKeyCalls = mutableListOf<InputKeyCall>()
  val toolCalls = mutableListOf<ToolCall>()
  var gestureStreamSupported: Boolean = true
  var gestureFrameResult: InputActionResult =
    InputActionResult(action = "input/gestureStart", success = true)
  val openedGestureStreams = mutableListOf<RecordingGestureStream>()
  var lastListPerformanceAuditResultsDeviceId: String? = null
}
