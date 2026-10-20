package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal fun payload(text: String): JsonObject = Json.parseToJsonElement(text) as JsonObject

// Current server builders: sessionOwnershipLostPayload, deviceLossOutcomeFromError,
// daemonShuttingDownMcpOutcome, and PlanExecutionOrchestrator.execute.
internal fun sessionOwnershipLostPayload(): JsonObject =
  payload(
    """{"error":{"code":"session_ownership_lost","message":"Session released",
      "sessionUuid":"test-session","reason":"explicit","retryable":false,
      "nextAction":"acquire_new_session",
      "recovery":{"action":"acquire_replacement_session","tools":["getAndroid","getApple"]}}}""",
  )

// Captured from sessionOwnershipLostPayload for a session terminalized by
// identity-recovery-owned-by-other-daemon (#11098).
internal fun otherDaemonTerminalSessionPayload(): JsonObject =
  payload(
    """{"error":{"code":"session_ownership_lost","message":"Session terminal",
      "sessionUuid":"test-session","reason":"identity-recovery-owned-by-other-daemon",
      "retryable":false,"nextAction":"acquire_new_session","ownerPid":4242,
      "recovery":{"action":"acquire_replacement_session","tools":["getAndroid","getApple"]},
      "release":{"sessionId":"test-session","deviceId":"emulator-5554",
      "releaseReason":"identity-recovery-owned-by-other-daemon","releasedAtMs":2,"terminal":true,
      "ownerPid":4242,"heartbeat":{"lastHeartbeatMs":1,"hasReceivedHeartbeat":true,
      "timeoutMs":20000,"ageMs":1}}}}""",
  )

// Shape of shapeToolCallError for an InputDeviceOwnedError
// (test/server/toolRegistry.deviceOwnership).
internal fun deviceOwnedPayload(): JsonObject =
  payload(
    """{"success":false,"error":"executePlan refused: device 'emulator-5554' is held by another session.","code":"device_owned_by_other_session","deviceId":"emulator-5554","retryable":false}""",
  )

// Shape of shapeToolCallError for a DeviceCleanupInProgressError (#10960).
internal fun deviceCleanupPayload(): JsonObject =
  payload(
    """{"success":false,"error":"Device 'emulator-5554' is still completing the previous session's cleanup","code":"device_cleanup_in_progress","deviceId":"emulator-5554","retryable":true,"retryAfterMs":4000}""",
  )

// Shape of shapeToolCallError for a DeviceOwnedByOtherDaemonError (#10980).
internal fun otherDaemonPayload(): JsonObject =
  payload(
    """{"success":false,"error":"Device 'emulator-5554' is claimed by another AutoMobile daemon (PID 4242)","code":"device_owned_by_other_daemon","deviceId":"emulator-5554","retryable":true,"retryAfterMs":2000}""",
  )

// Shape of shapeToolCallError for a DeviceShuttingDownError (#11088).
internal fun shuttingDownDevicePayload(): JsonObject =
  payload(
    """{"success":false,"error":"Device 'emulator-5554' is shutting down (code device_shutting_down)","code":"device_shutting_down","deviceId":"emulator-5554","retryable":true,"retryAfterMs":2000}""",
  )

// Shape of shapeToolCallError for the recording-finalize cleanup refusal (#11360).
internal fun finalizeRefusalPayload(code: String, retryAfterMs: Int?): JsonObject =
  payload(
    """{"success":false,"error":"finalizing","code":"$code","deviceId":"emulator-5554","retryable":true""" +
      (retryAfterMs?.let { ""","retryAfterMs":$it""" } ?: "") +
      "}",
  )

// Shape of shapeToolCallError for a retryable capacity / discovery refusal (#11202).
internal fun capacityPayload(code: String, retryable: Boolean, retryAfterMs: Int?): JsonObject =
  payload(
    """{"success":false,"error":"no capacity","code":"$code","retryable":$retryable""" +
      (retryAfterMs?.let { ""","retryAfterMs":$it""" } ?: "") +
      "}",
  )

internal fun deviceLostPayload(): JsonObject =
  payload(
    """{"code":"device_lost","deviceId":"emulator-5554","sessionUuid":"test-session",
      "reason":"confirmed-unavailable"}""",
  )

internal fun shutdownPayload(): JsonObject =
  payload(
    """{"error":{"code":"daemon_shutting_down","message":"Daemon is shutting down","retryable":true}}""",
  )

internal fun successPayload(): JsonObject =
  payload(
    """{"success":true,"executedSteps":1,"totalSteps":1,"platform":"android","deviceId":"emulator-5554"}""",
  )

internal fun buildDaemonResponse(payload: JsonObject, isError: Boolean = false): DaemonResponse =
  buildTextResponse(Json.encodeToString(JsonElement.serializer(), payload), isError)

internal fun buildTextResponse(text: String, isError: Boolean = false): DaemonResponse {
  val result =
    JsonObject(
      mapOf(
        "content" to
          JsonArray(
            listOf(
              JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text))),
            ),
          ),
        "isError" to JsonPrimitive(isError),
      ),
    )
  return DaemonResponse(id = "test", type = "mcp_response", success = true, result = result)
}
