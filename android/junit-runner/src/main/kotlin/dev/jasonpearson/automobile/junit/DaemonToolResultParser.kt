package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.ACQUIRE_NEW_SESSION_NEXT_ACTION
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.DEVICE_UNHEALTHY_CODE
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.RECOVERY_CODES
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.retryAfterHintMs
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object DaemonToolResultParser {
  // ── Response parsing ──────────────────────────────────────────────────────

  internal fun parseDaemonToolResult(response: DaemonResponse, json: Json): ParsedToolResult {
    if (!response.success) {
      // A failed frame carries the typed refusal fields at the top level (#11544).
      val code = (response.code as? JsonPrimitive)?.takeIf { it.isString }?.content
      val details = response.details as? JsonObject ?: JsonObject(emptyMap())
      val recovering = details["recovering"] == JsonPrimitive(true)
      val devices = unhealthyDevices(details, recovering)
      return ParsedToolResult(
        false,
        if (code == DEVICE_UNHEALTHY_CODE)
          PlanFailureMessages.unhealthyFailureMessage(
            response.error ?: "Daemon returned failure",
            recovering,
            devices,
          )
        else response.error ?: "Daemon returned failure",
        recovering = recovering,
        unhealthyDevices = devices,
        retryable = response.retryable == JsonPrimitive(true),
        code = code,
        daemonMessage = response.error,
        acquireNewSession =
          (response.nextAction as? JsonPrimitive)?.takeIf { it.isString }?.content ==
            ACQUIRE_NEW_SESSION_NEXT_ACTION,
        retryAfterMs = retryAfterHintMs(response.retryAfterMs),
        // Only an explicit `retryable: false` on a typed code is the daemon's final verdict; a
        // frame that omits the flag (older daemons, `daemon_queue_timeout` today) keeps the
        // message-based retry it always had.
        terminal = code != null && response.retryable == JsonPrimitive(false),
      )
    }

    val resultElement =
      response.result ?: return ParsedToolResult(false, "Daemon returned empty result")
    val resultObject =
      resultElement as? JsonObject
        ?: return ParsedToolResult(false, "Unexpected daemon response format: $resultElement")
    val isError = resultObject["isError"] == JsonPrimitive(true)
    val contentText =
      (resultObject["content"] as? JsonArray)
        ?.firstOrNull { (it as? JsonObject)?.get("type") == JsonPrimitive("text") }
        ?.let { (it as JsonObject)["text"] as? JsonPrimitive }
        ?.content
    val parsed =
      (resultObject["structuredContent"] as? JsonObject)
        ?: contentText?.let {
          try {
            json.parseToJsonElement(it) as? JsonObject
          } catch (e: SerializationException) {
            println("Warning: Failed to parse daemon result: ${e.message}")
            return ParsedToolResult(false, "Malformed daemon result: $it")
          }
        }
        ?: return ParsedToolResult(false, "Unexpected daemon response format: $resultElement")

    // JSON strings such as "true" are not an affirmative boolean plan result.
    val success = parsed["success"] == JsonPrimitive(true)
    return parseToolPayload(parsed, isError, success)
  }

  /** Reads the typed refusal fields from a daemon tool payload, top level or nested in `error`. */
  private fun parseToolPayload(
    parsed: JsonObject,
    isError: Boolean,
    success: Boolean,
  ): ParsedToolResult {
    val errorObject = parsed["error"] as? JsonObject
    val recovering = (errorObject?.get("recovering") ?: parsed["recovering"]) == JsonPrimitive(true)
    val devices =
      unhealthyDevices(JsonObject(parsed + (errorObject ?: JsonObject(emptyMap()))), recovering)
    val retryable = isRetryable(parsed, errorObject)
    // A terminal-session refusal says `retryable: false` for its UUID and `nextAction:
    // acquire_new_session` (#11098); a retry here always runs under a fresh session UUID.
    val acquireNewSession =
      ((errorObject?.get("nextAction") ?: parsed["nextAction"]) as? JsonPrimitive)
        ?.takeIf { it.isString }
        ?.content == ACQUIRE_NEW_SESSION_NEXT_ACTION
    if (isError || parsed.containsKey("error") || !success) {
      // The typed `code` (never the message) is what clients match on.
      val code =
        ((errorObject?.get("code") ?: parsed["code"]) as? JsonPrimitive)
          ?.takeIf { it.isString }
          ?.content
      val daemonMessage = daemonMessage(parsed, errorObject, code)
      return ParsedToolResult(
        false,
        if (code == DEVICE_UNHEALTHY_CODE)
          PlanFailureMessages.unhealthyFailureMessage(
            daemonMessage ?: "Daemon refused the request",
            recovering,
            devices,
          )
        else PlanFailureMessages.planFailureMessage(parsed, isError),
        retryable,
        code,
        daemonMessage,
        sessionHeld =
          when (parsed["sessionHeld"]) {
            JsonPrimitive(true) -> true
            JsonPrimitive(false) -> false
            else -> null
          },
        recovering = recovering,
        unhealthyDevices = devices,
        acquireNewSession = acquireNewSession,
        retryAfterMs = retryAfterHintMs(errorObject?.get("retryAfterMs") ?: parsed["retryAfterMs"]),
      )
    }
    return ParsedToolResult(true, "")
  }

  /**
   * How a refusal rendered into a thrown tool error (`... returned an error: {json}`) is handled,
   * decided by the same typed fields and wait rule as the `executePlan` loop (the
   * `test/fixtures/refusal-wire` table). Null when the text carries no JSON object.
   */
  internal data class RefusalVerdict(
    val disposition: RefusalDisposition,
    val code: String?,
    val retryAfterMs: Long?,
  )

  internal fun classifyRefusalText(text: String, json: Json = Json): RefusalVerdict? {
    val start = text.indexOf('{')
    val end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    val payload =
      try {
        json.parseToJsonElement(text.substring(start, end + 1)) as? JsonObject
      } catch (e: SerializationException) {
        println("Warning: refusal text is not a JSON payload: ${e.message}")
        null
      } ?: return null
    val parsed = parseToolPayload(payload, isError = true, success = false)
    return RefusalVerdict(refusalDisposition(parsed), parsed.code, parsed.retryAfterMs)
  }

  /** How the runner reacts to a daemon refusal; one row of `test/fixtures/refusal-wire`. */
  internal enum class RefusalDisposition(val wire: String) {
    WAIT("wait"),
    ACQUIRE_NEW_SESSION("acquire-new-session"),
    RETRY("retry"),
    FAIL("fail"),
  }

  internal fun refusalDisposition(parsed: ParsedToolResult): RefusalDisposition =
    when {
      DeviceWaitPolicy.waitsForDevice(parsed) -> RefusalDisposition.WAIT
      parsed.acquireNewSession -> RefusalDisposition.ACQUIRE_NEW_SESSION
      parsed.retryable -> RefusalDisposition.RETRY
      else -> RefusalDisposition.FAIL
    }

  /** Classifies a failed daemon tool response the way the executePlan loop does. */
  internal fun classifyRefusal(response: DaemonResponse, json: Json): RefusalDisposition =
    refusalDisposition(parseDaemonToolResult(response, json))

  /** What the runner reads from a refusal; pinned per fixture in `expectations.json`. */
  internal data class RefusalEvidence(
    val code: String?,
    val retryable: Boolean,
    val acquireNewSession: Boolean,
    val retryAfterMs: Long?,
    val recovering: Boolean,
  )

  internal fun refusalEvidence(response: DaemonResponse, json: Json): RefusalEvidence =
    parseDaemonToolResult(response, json).let {
      RefusalEvidence(it.code, it.retryable, it.acquireNewSession, it.retryAfterMs, it.recovering)
    }

  internal data class UnhealthyDevice(
    val deviceId: String,
    val reason: String,
    val recovering: Boolean,
  )

  private fun unhealthyDevices(payload: JsonObject, recovering: Boolean): List<UnhealthyDevice> {
    fun device(objectValue: JsonObject, state: Boolean): UnhealthyDevice? {
      val id =
        (objectValue["deviceId"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      val reason =
        (objectValue["reason"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      return UnhealthyDevice(id, reason, state)
    }
    val devices = payload["devices"] as? JsonArray
    if (devices != null)
      return devices.mapNotNull {
        val entry = it as? JsonObject ?: return@mapNotNull null
        device(entry, entry["recovering"] == JsonPrimitive(true))
      }
    return listOfNotNull(device(payload, recovering))
  }

  // ── Internal types ────────────────────────────────────────────────────────

  internal data class ParsedToolResult(
    val success: Boolean,
    val errorMessage: String,
    val retryable: Boolean = false,
    /** The daemon's typed error `code`, when it sent one. */
    val code: String? = null,
    /** The daemon's human-readable `error` string, when it sent one. */
    val daemonMessage: String? = null,
    /**
     * Whether the daemon kept the session after a failed run that asked to hold it (#11091); null
     * when it did not say.
     */
    val sessionHeld: Boolean? = null,
    /** The refusal named a terminal session UUID and told the client to acquire a new one. */
    val acquireNewSession: Boolean = false,
    /** The daemon's `retryAfterMs` hint for a retryable refusal, when it sent one. */
    val retryAfterMs: Long? = null,
    /** A typed failed frame said `retryable: false`: the daemon's final verdict (#11544). */
    val terminal: Boolean = false,
    val recovering: Boolean = false,
    val unhealthyDevices: List<UnhealthyDevice> = emptyList(),
  )

  private fun daemonMessage(parsed: JsonObject, errorObject: JsonObject?, code: String?): String? {
    return (if (code in RECOVERY_CODES) errorObject?.get("message") as? JsonPrimitive else null)
      ?.takeIf { it.isString }
      ?.content ?: (parsed["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
  }

  private fun isRetryable(parsed: JsonObject, errorObject: JsonObject?): Boolean =
    errorObject?.get("retryable") == JsonPrimitive(true) ||
      parsed["retryable"] == JsonPrimitive(true)
}
