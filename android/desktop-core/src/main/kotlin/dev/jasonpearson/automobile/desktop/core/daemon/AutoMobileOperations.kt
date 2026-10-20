package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

interface AutoMobileDeviceOperations {
  fun getNavigationGraph(platform: String = "android"): JsonElement

  fun startDevice(
    name: String,
    platform: String,
    deviceId: String? = null,
  ): StartDeviceResult

  fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult

  fun observe(platform: String = "android"): ObserveResult

  /**
   * Stops a device.
   *
   * @param force skips the emulator-console AVD-name confirmation and acts on the serial as given
   *   (auto-mobile #6864). Only meaningful for a wedged Android emulator; accepted and ignored for
   *   iOS and physical devices. It does not override the conflict check, it removes it.
   */
  fun killDevice(
    name: String,
    deviceId: String,
    platform: String,
    force: Boolean = false,
  ): KillDeviceResult

  fun getDaemonStatus(): dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse

  fun updateService(deviceId: String, platform: String): UpdateServiceResult
}

interface AutoMobileTestOperations {
  fun getTestTimings(query: TestTimingQuery = TestTimingQuery()): TestTimingSummary

  fun getTestRuns(query: TestRunQuery = TestRunQuery()): TestRunSummary

  fun startDeviceGestureRecording(platform: String = "android"): DeviceGestureRecordingStartResult

  fun stopDeviceGestureRecording(
    recordingId: String? = null,
    planName: String? = null,
  ): DeviceGestureRecordingStopResult

  fun executePlan(
    planContent: String,
    platform: String = "android",
    startStep: Int? = null,
    sessionUuid: String? = null,
  ): ExecutePlanResult
}

interface AutoMobileInputOperations {
  fun inputTap(input: TapInput): InputActionResult

  fun inputSwipe(input: SwipeInput): InputActionResult

  fun inputPressButton(
    button: String,
    platform: String = "android",
    deviceId: String? = null,
    frameContext: String? = null,
  ): InputActionResult

  /**
   * @param append when true, requests the daemon's non-destructive append mode: the text is added
   *   to the focused field with real key events instead of REPLACING its contents via
   *   `ACTION_SET_TEXT`. Required by any client mirroring a keyboard one keystroke at a time, which
   *   would otherwise leave only the last character typed. Android-only; the daemon rejects it on
   *   iOS (issue #3351).
   */
  fun inputTypeText(input: TextInput): InputActionResult

  fun inputKey(
    key: String,
    platform: String = "android",
    deviceId: String? = null,
    frameContext: String? = null,
  ): InputActionResult

  /**
   * Open a persistent connection for one streamed (real-time) gesture — a drag delivered as a down,
   * incremental moves, and an up over a single held connection, so the device tracks the pointer
   * live instead of receiving one atomic `input/swipe` on release.
   *
   * Returns null when streaming is unavailable — the transport can't hold a connection open (HTTP /
   * stdio), the daemon does not advertise `input/gestureStream`, or the platform is not Android —
   * in which case the caller falls back to [inputSwipe]. The default is null so only the
   * Unix-socket client implements it; every other transport degrades cleanly (issue: streaming
   * gesture input).
   */
  fun openGestureStream(
    platform: String = "android",
    deviceId: String? = null,
  ): GestureInputStream? = null
}

interface AutoMobileStorageOperations {
  fun setKeyValue(input: SetKeyValueRequest): SetKeyValueResult

  fun removeKeyValue(input: RemoveKeyValueRequest): RemoveKeyValueResult

  fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String = "android",
    sessionUuid: String? = null,
  ): ClearKeyValueResult
}

interface AutoMobileFeatureOperations {
  fun listFeatureFlags(): List<FeatureFlagState>

  fun setFeatureFlag(key: String, enabled: Boolean, config: JsonObject? = null): FeatureFlagState

  fun listPerformanceAuditResults(
    startTime: String? = null,
    endTime: String? = null,
    limit: Int? = null,
    offset: Int? = null,
    deviceId: String? = null,
  ): PerformanceAuditHistoryResult
}
