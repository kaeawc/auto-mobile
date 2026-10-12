package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

interface DeviceGestureRecordingClient {
  fun startDeviceGestureRecording(platform: String? = null): DeviceGestureRecordingStartResult

  fun stopDeviceGestureRecording(
    recordingId: String? = null,
    planName: String? = null,
  ): DeviceGestureRecordingStopResult
}

class DeviceGestureRecordingSocketClient
internal constructor(
  private val socketPathValue: String = DeviceGestureRecordingSocketPaths.socketPath(),
  private val json: Json = DaemonJson,
  private val requestTimeoutMs: Long = DEVICE_GESTURE_RECORDING_REQUEST_TIMEOUT_MS,
  private val watchdog: SocketRequestWatchdog,
) : DeviceGestureRecordingClient {
  constructor(
    socketPathValue: String = DeviceGestureRecordingSocketPaths.socketPath(),
    json: Json = DaemonJson,
    requestTimeoutMs: Long = DEVICE_GESTURE_RECORDING_REQUEST_TIMEOUT_MS,
  ) : this(
    socketPathValue,
    json,
    requestTimeoutMs,
    SharedSocketRequestWatchdog,
  )

  override fun startDeviceGestureRecording(platform: String?): DeviceGestureRecordingStartResult {
    val response = sendRequest(DeviceGestureRecordingSocketCommand(command = "start", platform = platform))
    ensureSuccess(response)
    return DeviceGestureRecordingStartResult(
      recordingId = response.recordingId ?: throw missingField("recordingId"),
      startedAt = response.startedAt ?: throw missingField("startedAt"),
      deviceId = response.deviceId,
      platform = response.platform,
    )
  }

  override fun stopDeviceGestureRecording(
    recordingId: String?,
    planName: String?,
  ): DeviceGestureRecordingStopResult {
    val response =
      sendRequest(
        DeviceGestureRecordingSocketCommand(
          command = "stop",
          recordingId = recordingId,
          planName = planName,
        ),
      )
    ensureSuccess(response)
    return DeviceGestureRecordingStopResult(
      recordingId = response.recordingId ?: throw missingField("recordingId"),
      startedAt = response.startedAt ?: throw missingField("startedAt"),
      stoppedAt = response.stoppedAt ?: throw missingField("stoppedAt"),
      durationMs = response.durationMs ?: throw missingField("durationMs"),
      planName = response.planName ?: throw missingField("planName"),
      planContent = response.planContent ?: throw missingField("planContent"),
      stepCount = response.stepCount ?: throw missingField("stepCount"),
      deviceId = response.deviceId,
      platform = response.platform,
    )
  }

  private fun sendRequest(request: DeviceGestureRecordingSocketCommand): DeviceGestureRecordingSocketResponse {
    ensureSocketExists()

    val line =
      oneShotSocketRequest(
        socketPath = socketPathValue,
        requestLine = json.encodeToString(request),
        timeoutMs = requestTimeoutMs,
        label = "Device gesture recording",
        watchdog = watchdog,
      )

    return json.decodeFromString(line)
  }

  private fun ensureSocketExists() {
    val path = File(socketPathValue).toPath()
    if (!Files.exists(path)) {
      throw McpConnectionException("Device gesture recording socket not found at $socketPathValue")
    }
  }

  private fun ensureSuccess(response: DeviceGestureRecordingSocketResponse) {
    if (!response.success) {
      throw McpConnectionException(response.error ?: "Device gesture recording request failed")
    }
  }

  private fun missingField(name: String): McpConnectionException {
    return McpConnectionException("Device gesture recording response missing $name")
  }
}

data class FakeDeviceGestureRecordingStartCall(val platform: String?)

data class FakeDeviceGestureRecordingStopCall(val recordingId: String?, val planName: String?)

class FakeDeviceGestureRecordingClient(
  private val startResponses: List<DeviceGestureRecordingStartResult> = emptyList(),
  private val stopResponses: List<DeviceGestureRecordingStopResult> = emptyList(),
) : DeviceGestureRecordingClient {
  val startCalls = mutableListOf<FakeDeviceGestureRecordingStartCall>()
  val stopCalls = mutableListOf<FakeDeviceGestureRecordingStopCall>()
  private var startIndex = 0
  private var stopIndex = 0

  override fun startDeviceGestureRecording(platform: String?): DeviceGestureRecordingStartResult {
    startCalls.add(FakeDeviceGestureRecordingStartCall(platform))
    if (startResponses.isEmpty()) {
      throw IllegalStateException("No start responses configured")
    }
    val response = startResponses.getOrNull(startIndex) ?: startResponses.last()
    startIndex += 1
    return response
  }

  override fun stopDeviceGestureRecording(recordingId: String?, planName: String?): DeviceGestureRecordingStopResult {
    stopCalls.add(FakeDeviceGestureRecordingStopCall(recordingId, planName))
    if (stopResponses.isEmpty()) {
      throw IllegalStateException("No stop responses configured")
    }
    val response = stopResponses.getOrNull(stopIndex) ?: stopResponses.last()
    stopIndex += 1
    return response
  }

  companion object {
    /** Creates a FakeDeviceGestureRecordingClient with sample responses for UI development/testing. */
    fun withSampleResponses(): FakeDeviceGestureRecordingClient {
      val sampleYaml =
        """
        |name: recorded-plan-2026-02-01T10-30-00
        |description: Recorded test plan with 5 steps
        |steps:
        |  - tool: tapOn
        |    params:
        |      elementId: "com.example.app:id/login_button"
        |      description: "Login button"
        |  - tool: inputText
        |    params:
        |      text: "user@example.com"
        |      elementId: "com.example.app:id/email_field"
        |  - tool: inputText
        |    params:
        |      text: "password123"
        |      elementId: "com.example.app:id/password_field"
        |  - tool: tapOn
        |    params:
        |      elementId: "com.example.app:id/submit_button"
        |      description: "Submit button"
        |  - tool: observe
        |    params:
        |      waitForIdle: true
        """
          .trimMargin()

      return FakeDeviceGestureRecordingClient(
        startResponses =
          listOf(
            DeviceGestureRecordingStartResult(
              recordingId = "rec-001",
              startedAt = "2026-02-01T10:30:00Z",
              deviceId = "emulator-5554",
              platform = "android",
            ),
          ),
        stopResponses =
          listOf(
            DeviceGestureRecordingStopResult(
              recordingId = "rec-001",
              startedAt = "2026-02-01T10:30:00Z",
              stoppedAt = "2026-02-01T10:30:12Z",
              durationMs = 12345L,
              planName = "recorded-plan-2026-02-01T10-30-00",
              planContent = sampleYaml,
              stepCount = 5,
              deviceId = "emulator-5554",
              platform = "android",
            ),
          ),
      )
    }
  }
}

object DeviceGestureRecordingSocketPaths {
  fun socketPath(): String = AutoMobileSocketPaths.socketPath("device-gesture-recording.sock")
}

@Serializable
private data class DeviceGestureRecordingSocketCommand(
  val command: String,
  val deviceId: String? = null,
  val platform: String? = null,
  val recordingId: String? = null,
  val planName: String? = null,
)

@Serializable
private data class DeviceGestureRecordingSocketResponse(
  val success: Boolean,
  val recordingId: String? = null,
  val startedAt: String? = null,
  val stoppedAt: String? = null,
  val deviceId: String? = null,
  val platform: String? = null,
  val planName: String? = null,
  val planContent: String? = null,
  val stepCount: Int? = null,
  val durationMs: Long? = null,
  val error: String? = null,
)
