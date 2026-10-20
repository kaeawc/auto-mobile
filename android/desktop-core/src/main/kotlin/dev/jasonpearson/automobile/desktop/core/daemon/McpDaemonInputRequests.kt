package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.serializer

/** [params] plus the `sessionUuid` input acts for, when there is one (#10698). */
internal fun McpDaemonClient.withInputSession(params: JsonObject): JsonObject {
  val session = inputSessionUuidProvider() ?: sessionUuid
  if (session.isNullOrBlank() || "sessionUuid" in params) return params
  return JsonObject(params + ("sessionUuid" to JsonPrimitive(session)))
}

internal fun McpDaemonClient.sendInputRequest(
  method: String,
  params: JsonObject,
): InputActionResult {
  // Input rides the tighter deadline: a hung input/* call froze the pane's whole input path
  // (single dispatch thread + FIFO mutex), and live interaction would rather shed one tap
  // after 5s than sit dead for a minute.
  val response = sendRequest(method, withInputSession(params), timeoutMs = inputRequestTimeoutMs)
  if (!response.success) {
    return response.toFailedInputResult(method)
  }
  val result =
    response.result
      ?: return InputActionResult(
        action = method,
        success = false,
        error = "Daemon response missing result",
      )
  val inputResult = json.decodeFromJsonElement(serializer<InputActionResult>(), result)
  if (inputResult.action != method) {
    return InputActionResult(
      action = method,
      success = false,
      error = "Daemon response action ${inputResult.action} did not match $method",
    )
  }
  return inputResult
}

/** A failure frame's code, `retryable` and `details.remainingMs`, kept on the input result. */
internal fun DaemonResponse.toFailedInputResult(method: String): InputActionResult =
  InputActionResult(
    action = method,
    success = false,
    error = error,
    code = code?.contentOrNull,
    retryable = retryable,
    retryAfterMs = (details?.get("remainingMs") as? JsonPrimitive)?.longOrNull,
  )
