package dev.jasonpearson.automobile.desktop.core.testing

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileDeviceOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileFeatureOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileInputOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileStorageOperations
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileTestOperations
import dev.jasonpearson.automobile.desktop.core.daemon.ClearKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceGestureRecordingStartResult
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceGestureRecordingStopResult
import dev.jasonpearson.automobile.desktop.core.daemon.ExecutePlanResult
import dev.jasonpearson.automobile.desktop.core.daemon.FeatureFlagState
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.KillDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.ObserveResult
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult
import dev.jasonpearson.automobile.desktop.core.daemon.RemoveKeyValueRequest
import dev.jasonpearson.automobile.desktop.core.daemon.RemoveKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.SetActiveDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.SetKeyValueRequest
import dev.jasonpearson.automobile.desktop.core.daemon.SetKeyValueResult
import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.SwipeInput
import dev.jasonpearson.automobile.desktop.core.daemon.TapInput
import dev.jasonpearson.automobile.desktop.core.daemon.TestRunQuery
import dev.jasonpearson.automobile.desktop.core.daemon.TestRunSummary
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingQuery
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingSummary
import dev.jasonpearson.automobile.desktop.core.daemon.TextInput
import dev.jasonpearson.automobile.desktop.core.daemon.UpdateServiceResult
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.ClearKeyValueFileCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputKeyCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputPressButtonCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputSwipeCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputTapCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.InputTypeTextCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.RemoveKeyValueCall
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient.SetKeyValueCall
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

internal class FakeDeviceOperations(private val state: FakeAutoMobileClientState) :
  AutoMobileDeviceOperations {
  override fun getNavigationGraph(platform: String): JsonElement {
    return with(state) {
      calls.add("getNavigationGraph")
      return@with getNavigationGraphResult
    }
  }

  override fun startDevice(name: String, platform: String, deviceId: String?): StartDeviceResult {
    return with(state) {
      calls.add("startDevice")
      return@with queuedStartDeviceResults.removeFirstOrNull() ?: startDeviceResult
    }
  }

  override fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult {
    return with(state) {
      calls.add("setActiveDevice")
      return@with setActiveDeviceResult
    }
  }

  override fun observe(platform: String): ObserveResult {
    return with(state) {
      calls.add("observe")
      observeError?.let { throw it }
      return@with observeResult
    }
  }

  override fun killDevice(
    name: String,
    deviceId: String,
    platform: String,
    force: Boolean,
  ): KillDeviceResult {
    return with(state) {
      calls.add("killDevice")
      killDeviceForceRequests.add(force)
      return@with killDeviceResult
    }
  }

  override fun getDaemonStatus(): DaemonStatusResponse {
    return with(state) {
      calls.add("getDaemonStatus")
      getDaemonStatusError?.let { throw it }
      return@with getDaemonStatusResult
    }
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    return with(state) {
      calls.add("updateService")
      return@with updateServiceResult
    }
  }
}

internal class FakeTestOperations(private val state: FakeAutoMobileClientState) :
  AutoMobileTestOperations {
  override fun getTestTimings(query: TestTimingQuery): TestTimingSummary {
    return with(state) {
      calls.add("getTestTimings")
      return@with getTestTimingsResult
    }
  }

  override fun getTestRuns(query: TestRunQuery): TestRunSummary {
    return with(state) {
      calls.add("getTestRuns")
      return@with getTestRunsResult
    }
  }

  override fun startDeviceGestureRecording(platform: String): DeviceGestureRecordingStartResult {
    return with(state) {
      calls.add("startDeviceGestureRecording")
      return@with startDeviceGestureRecordingResult
    }
  }

  override fun stopDeviceGestureRecording(
    recordingId: String?,
    planName: String?,
  ): DeviceGestureRecordingStopResult {
    return with(state) {
      calls.add("stopDeviceGestureRecording")
      return@with stopDeviceGestureRecordingResult
    }
  }

  override fun executePlan(
    planContent: String,
    platform: String,
    startStep: Int?,
    sessionUuid: String?,
  ): ExecutePlanResult {
    return with(state) {
      calls.add("executePlan")
      return@with executePlanResult
    }
  }
}

internal class FakeInputOperations(private val state: FakeAutoMobileClientState) :
  AutoMobileInputOperations {
  override fun inputTap(input: TapInput): InputActionResult {
    return with(state) {
      val x = input.x
      val y = input.y
      val platform = input.platform
      val deviceId = input.deviceId
      val duration = input.duration
      val frameContext = input.frameContext

      calls.add("inputTap")
      inputTapCalls.add(InputTapCall(x, y, platform, deviceId, duration, frameContext))
      return@with inputTapResult
    }
  }

  override fun inputSwipe(input: SwipeInput): InputActionResult {
    return with(state) {
      val startX = input.startX
      val startY = input.startY
      val endX = input.endX
      val endY = input.endY
      val platform = input.platform
      val deviceId = input.deviceId
      val durationMs = input.durationMs
      val frameContext = input.frameContext

      calls.add("inputSwipe")
      inputSwipeCalls.add(
        InputSwipeCall(startX, startY, endX, endY, platform, deviceId, durationMs, frameContext),
      )
      return@with inputSwipeResult
    }
  }

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    return with(state) {
      calls.add("inputPressButton")
      inputPressButtonCalls.add(InputPressButtonCall(button, platform, deviceId, frameContext))
      return@with inputPressButtonResult
    }
  }

  override fun inputTypeText(input: TextInput): InputActionResult {
    return with(state) {
      val text = input.text
      val platform = input.platform
      val deviceId = input.deviceId
      val submit = input.submit
      val append = input.append
      val frameContext = input.frameContext

      calls.add("inputTypeText")
      inputTypeTextCalls.add(
        InputTypeTextCall(text, platform, deviceId, submit, append, frameContext),
      )
      return@with inputTypeTextResult
    }
  }

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    return with(state) {
      calls.add("inputKey")
      inputKeyCalls.add(InputKeyCall(key, platform, deviceId, frameContext))
      return@with inputKeyResult
    }
  }
}

internal class FakeStorageOperations(private val state: FakeAutoMobileClientState) :
  AutoMobileStorageOperations {
  override fun setKeyValue(input: SetKeyValueRequest): SetKeyValueResult {
    return with(state) {
      val deviceId = input.deviceId
      val appId = input.appId
      val fileName = input.fileName
      val key = input.key
      val value = input.value
      val type = input.type
      val platform = input.platform
      val sessionUuid = input.sessionUuid

      calls.add("setKeyValue")
      setKeyValueCalls.add(
        SetKeyValueCall(deviceId, appId, fileName, key, value, type, platform, sessionUuid),
      )
      onKeyValueMutation?.invoke()
      return@with setKeyValueResult
    }
  }

  override fun removeKeyValue(input: RemoveKeyValueRequest): RemoveKeyValueResult {
    return with(state) {
      val deviceId = input.deviceId
      val appId = input.appId
      val fileName = input.fileName
      val key = input.key
      val platform = input.platform
      val sessionUuid = input.sessionUuid

      calls.add("removeKeyValue")
      removeKeyValueCalls.add(
        RemoveKeyValueCall(deviceId, appId, fileName, key, platform, sessionUuid),
      )
      onKeyValueMutation?.invoke()
      return@with removeKeyValueResult
    }
  }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
    sessionUuid: String?,
  ): ClearKeyValueResult {
    return with(state) {
      calls.add("clearKeyValueFile")
      clearKeyValueFileCalls.add(
        ClearKeyValueFileCall(deviceId, appId, fileName, platform, sessionUuid),
      )
      onKeyValueMutation?.invoke()
      return@with clearKeyValueFileResult
    }
  }
}

internal class FakeFeatureOperations(private val state: FakeAutoMobileClientState) :
  AutoMobileFeatureOperations {
  override fun listFeatureFlags(): List<FeatureFlagState> {
    return with(state) {
      calls.add("listFeatureFlags")
      return@with listFeatureFlagsResult
    }
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    return with(state) {
      calls.add("setFeatureFlag")
      return@with setFeatureFlagResult
    }
  }

  override fun listPerformanceAuditResults(
    startTime: String?,
    endTime: String?,
    limit: Int?,
    offset: Int?,
    deviceId: String?,
  ): PerformanceAuditHistoryResult {
    return with(state) {
      calls.add("listPerformanceAuditResults")
      lastListPerformanceAuditResultsDeviceId = deviceId
      // Mirror the performance-results resource's server-side deviceId filter so device-scoped
      // reads only surface their own device's entries.
      if (deviceId == null) {
        return@with listPerformanceAuditResultsResult
      }
      val scoped = listPerformanceAuditResultsResult.results.filter { it.deviceId == deviceId }
      return@with listPerformanceAuditResultsResult.copy(results = scoped)
    }
  }
}
