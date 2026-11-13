package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.parseDaemonToolResult
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Acquires the device session one `executePlan` attempt runs under (#17953).
 *
 * The daemon refuses a never-issued `sessionUuid` on `setToolEnabled` and `executePlan`
 * (#6069, #6148), so a runner-minted UUID never reaches a plan step. Like the XCTestRunner, the
 * runner acquires a session with `getAndroid` and uses the UUID the daemon issued. The daemon keeps
 * a session the caller held before the plan started, so the runner releases it when the attempt
 * ends.
 */
internal interface PlanSessionAcquirer {
  /** Acquire [deviceId], or a device the daemon chooses when null. */
  fun acquire(deviceId: String?, timeoutMs: Long): PlanSessionAcquisition

  /** Best-effort release of a session [acquire] issued. */
  fun release(sessionUuid: String)
}

internal sealed interface PlanSessionAcquisition {
  data class Acquired(val sessionUuid: String) : PlanSessionAcquisition

  /** The daemon refused or failed the acquisition; [parsed] keeps its typed refusal fields. */
  data class Failed(
    val response: DaemonResponse,
    val outputPayload: String,
    val parsed: ParsedToolResult,
  ) : PlanSessionAcquisition
}

internal class DaemonPlanSessionAcquirer(private val daemon: DaemonToolClient) :
  PlanSessionAcquirer {
  private val json = Json { ignoreUnknownKeys = true }

  override fun acquire(deviceId: String?, timeoutMs: Long): PlanSessionAcquisition {
    val arguments =
      JsonObject(
        if (deviceId != null) mapOf("deviceId" to JsonPrimitive(deviceId)) else emptyMap(),
      )
    val response =
      try {
        daemon.callTool(ACQUIRE_TOOL, arguments, timeoutMs)
      } catch (error: DaemonUnavailableException) {
        DaemonResponse(
          id = "",
          type = "mcp_response",
          success = false,
          error = error.message ?: "daemon request timeout",
        )
      }
    return interpretAcquisition(response, deviceId, json)
  }

  override fun release(sessionUuid: String) {
    val response =
      try {
        daemon.callDaemonMethod(
          RELEASE_SESSION_METHOD,
          JsonObject(mapOf("sessionId" to JsonPrimitive(sessionUuid))),
          RELEASE_TIMEOUT_MS,
        )
      } catch (error: DaemonUnavailableException) {
        DaemonResponse(id = "", type = "daemon_response", success = false, error = error.message)
      }
    if (!response.success) {
      println(
        "Warning: could not release plan session $sessionUuid (${response.error}); it lapses " +
          "at its heartbeat timeout",
      )
    }
  }

  internal companion object {
    const val ACQUIRE_TOOL = "getAndroid"
    private const val RELEASE_SESSION_METHOD = "daemon/releaseSession"
    private const val RELEASE_TIMEOUT_MS = 10_000L

    /** Reads the issued `runtime.session.sessionUuid`, or the failure to report in its place. */
    fun interpretAcquisition(
      response: DaemonResponse,
      deviceId: String?,
      json: Json,
    ): PlanSessionAcquisition {
      val outputPayload =
        response.result?.let { json.encodeToString(JsonElement.serializer(), it) } ?: ""
      val target = deviceId ?: "a free Android device"
      val lead = "Could not acquire $target with $ACQUIRE_TOOL"
      if (!response.success) {
        val parsed = parseDaemonToolResult(response, json)
        val message = "$lead: ${response.error ?: parsed.errorMessage}"
        return PlanSessionAcquisition.Failed(
          response.copy(error = message),
          outputPayload,
          parsed.copy(errorMessage = message),
        )
      }
      val result = response.result as? JsonObject
      val isError = result?.get("isError") == JsonPrimitive(true)
      val sessionUuid = result?.let { payloadOf(it, json) }?.let(::issuedSessionUuid)
      if (!isError && sessionUuid != null) {
        return PlanSessionAcquisition.Acquired(sessionUuid)
      }
      // An acquisition payload carries no `success` flag, so only an error result has a reason.
      val parsed = parseDaemonToolResult(response, json)
      val reason =
        if (isError) parsed.errorMessage else "the result has no runtime.session.sessionUuid"
      return PlanSessionAcquisition.Failed(
        response,
        outputPayload,
        parsed.copy(success = false, errorMessage = "$lead: $reason"),
      )
    }

    private fun payloadOf(result: JsonObject, json: Json): JsonObject? =
      (result["structuredContent"] as? JsonObject)
        ?: (result["content"] as? JsonArray)
          ?.firstOrNull { (it as? JsonObject)?.get("type") == JsonPrimitive("text") }
          ?.let { ((it as JsonObject)["text"] as? JsonPrimitive)?.content }
          ?.let {
            try {
              json.parseToJsonElement(it) as? JsonObject
            } catch (e: SerializationException) {
              println("Warning: could not parse $ACQUIRE_TOOL result: ${e.message}")
              null
            }
          }

    private fun issuedSessionUuid(payload: JsonObject): String? {
      val session = (payload["runtime"] as? JsonObject)?.get("session") as? JsonObject
      return (session?.get("sessionUuid") as? JsonPrimitive)
        ?.takeIf { it.isString }
        ?.content
        ?.takeIf { it.isNotBlank() }
    }
  }
}
