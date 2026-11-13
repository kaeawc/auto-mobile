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
    // getAndroid needs a device (it rejects a call naming neither deviceId nor avdName), so
    // "let the daemon choose" picks a booted device the daemon lists as free.
    val target =
      deviceId
        ?: when (val choice = chooseBootedDevice(timeoutMs)) {
          is BootedDeviceChoice.Chosen -> choice.deviceId
          is BootedDeviceChoice.None -> return noDeviceFailure(choice.reason)
        }
    val response =
      try {
        daemon.callTool(
          ACQUIRE_TOOL,
          JsonObject(mapOf("deviceId" to JsonPrimitive(target))),
          timeoutMs,
        )
      } catch (error: DaemonUnavailableException) {
        DaemonResponse(
          id = "",
          type = "mcp_response",
          success = false,
          error = error.message ?: "daemon request timeout",
        )
      }
    return interpretAcquisition(response, target, json)
  }

  private fun chooseBootedDevice(timeoutMs: Long): BootedDeviceChoice {
    val response =
      try {
        daemon.readResource(BOOTED_ANDROID_URI, timeoutMs)
      } catch (error: DaemonUnavailableException) {
        return BootedDeviceChoice.None("could not read $BOOTED_ANDROID_URI: ${error.message}")
      }
    val text =
      TestTimingRequest.extractResourcePayload(response)
        ?: return BootedDeviceChoice.None(
          "could not read $BOOTED_ANDROID_URI: ${response.error ?: "empty response"}",
        )
    val devices =
      try {
        (json.parseToJsonElement(text) as? JsonObject)?.get("devices") as? JsonArray
      } catch (e: SerializationException) {
        return BootedDeviceChoice.None("could not parse $BOOTED_ANDROID_URI: ${e.message}")
      }
    return chooseBootedDevice(devices ?: JsonArray(emptyList()))
  }

  private fun noDeviceFailure(reason: String): PlanSessionAcquisition.Failed {
    val message =
      "Could not acquire an Android device with $ACQUIRE_TOOL: $reason. Boot an emulator or " +
        "connect a device, or set ANDROID_SERIAL to the one to use"
    val response = DaemonResponse(id = "", type = "mcp_response", success = false, error = message)
    return PlanSessionAcquisition.Failed(response, "", ParsedToolResult(false, message))
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

  internal sealed interface BootedDeviceChoice {
    data class Chosen(val deviceId: String) : BootedDeviceChoice

    data class None(val reason: String) : BootedDeviceChoice
  }

  internal companion object {
    const val ACQUIRE_TOOL = "getAndroid"
    const val BOOTED_ANDROID_URI = "automobile:devices/booted/android"

    /**
     * The first online booted device no session holds. When every online device is held, the first
     * of them: getAndroid then answers with the daemon's typed refusal, so the attempt waits for it
     * like any other held device instead of failing outright.
     */
    fun chooseBootedDevice(devices: JsonArray): BootedDeviceChoice {
      val online = devices.mapNotNull { entry ->
        val runtime = (entry as? JsonObject)?.get("runtime") as? JsonObject
        val id =
          (runtime?.get("deviceId") as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.takeIf { it.isNotBlank() }
        if (id == null || runtime["connection"] is JsonObject) null else id to runtime
      }
      val free = online.firstOrNull { (_, runtime) ->
        runtime["session"] !is JsonObject &&
          runtime["heldBy"] == null &&
          (runtime["poolStatus"] as? JsonPrimitive)?.content.let {
            it != "assigned" && it != "error"
          }
      }
      val chosen = free ?: online.firstOrNull()
      return chosen?.let { BootedDeviceChoice.Chosen(it.first) }
        ?: BootedDeviceChoice.None("the daemon lists no online booted Android device")
    }

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
      val lead = "Could not acquire ${deviceId ?: "an Android device"} with $ACQUIRE_TOOL"
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
