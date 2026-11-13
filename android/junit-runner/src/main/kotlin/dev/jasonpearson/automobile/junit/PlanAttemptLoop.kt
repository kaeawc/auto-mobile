package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.RefusalDisposition
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.parseDaemonToolResult
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.refusalDisposition
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.RECOVERY_CODES
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.deviceOwnedBackoffDelayMs
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.deviceOwnedGiveUpMessage
import dev.jasonpearson.automobile.junit.PlanToolResultsParser.parseToolResults
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal class PlanAttemptLoop(
  private val collaborators: PlanExecutorCollaborators,
  private val releaseHeldSession: (String) -> Unit,
  sessionUuidOverride: String?,
  holdForRecovery: Boolean,
) {
  private var takenOverSession: String? = sessionUuidOverride.takeIf { !holdForRecovery }

  fun releaseTakenOverSession() {
    takenOverSession?.let { releaseHeldSession(it) }
    takenOverSession = null
  }

  fun execute(request: PlanExecutionRequest, holdForRecovery: Boolean): PlanAttemptOutcome {
    val options = request.options
    val maxRetries = options.maxRetries.coerceAtLeast(0)
    var attempt = 0
    val wait = DeviceWaitProgress()
    // Only the first attempt may reuse the failed attempt's session; every later attempt (a retry
    // or a pass after waiting for the device) acquires a fresh issued session (#17953).
    var reuseSession = request.sessionUuidOverride
    // When AI recovery may follow a failure, the daemon keeps the failed attempt's session and
    // device (#10834) so no other session can take the device between the attempt and recovery.
    // Every path that does not go on to recovery releases the held session itself.
    // A resumed run takes over the session the daemon held for recovery. Until this run's
    // executePlan reaches the daemon the runner still owns that session: it releases it before
    // switching to a fresh one or giving up, or the held session blocks the device until its lease
    // lapses (#11139).
    var outcome: PlanAttemptOutcome
    var parsed: ParsedToolResult

    // Retry loop for transient failures (timeouts, daemon busy)
    while (true) {
      attempt++
      outcome = performAttempt(request, holdForRecovery, reuseSession, attempt)
      reuseSession = null
      parsed = outcome.parsed
      val response = outcome.response

      PlanAttemptSupport.logResponse(options, response, outcome.outputPayload)

      if (response.success && parsed.success) {
        return outcome
      }

      val errorMessage = response.error ?: parsed.errorMessage
      val sessionUuid = outcome.attemptSessionUuid
      if (refusalDisposition(parsed) == RefusalDisposition.WAIT) {
        // Another session holds the device (typically a concurrent test attempt in this runner),
        // or its previous session is still finishing cleanup (#10960). Wait for it to free up,
        // within its own bounded budget, without spending maxRetries.
        if (!waitForDevice(parsed, errorMessage, sessionUuid, holdForRecovery, wait)) {
          parsed = parsed.copy(errorMessage = deviceOwnedGiveUpMessage(parsed, wait.elapsedMs))
          break
        }
        // A refusal consumes no executePlan retry; the next pass is the same attempt number.
        attempt--
        continue
      }
      if (attempt > maxRetries || !PlanAttemptSupport.shouldRetry(parsed, errorMessage)) {
        break
      }

      // The retry is a fresh session; the held one would otherwise keep the device from it.
      releaseForRetry(holdForRecovery, sessionUuid)
      println("Retrying plan execution after transient error (attempt $attempt): $errorMessage")
      Thread.sleep(collaborators.timings.retryBackoffMs)
    }

    return outcome.copy(parsed = parsed)
  }

  private fun performAttempt(
    request: PlanExecutionRequest,
    holdForRecovery: Boolean,
    reuseSession: String?,
    attempt: Int,
  ): PlanAttemptOutcome {
    val deviceId = PlanAttemptSupport.effectiveDeviceId(request, collaborators)
    val sessionUuid =
      reuseSession
        ?: when (
          val acquisition =
            collaborators.sessionAcquirer.acquire(
              deviceId,
              request.options.effectiveExecutePlanTimeoutMs(),
            )
        ) {
          is PlanSessionAcquisition.Acquired -> acquisition.sessionUuid
          is PlanSessionAcquisition.Failed ->
            return PlanAttemptSupport.acquisitionFailedOutcome(acquisition)
        }
    val acquired = reuseSession == null
    val args = PlanAttemptSupport.buildArguments(request, holdForRecovery, sessionUuid, deviceId)
    // Opt this device session into executePlan before invoking it.
    val selectionResponse = enableExecutePlan(sessionUuid, request.options)
    if (!selectionResponse.success) {
      return toolEnableFailedOutcome(selectionResponse, sessionUuid, acquired)
    }
    return runExecutePlan(request, holdForRecovery, sessionUuid, args, attempt)
  }

  private fun enableExecutePlan(
    sessionUuid: String,
    options: AutoMobilePlanExecutionOptions,
  ): DaemonResponse =
    callDaemonToolForAttempt(
      "setToolEnabled",
      JsonObject(
        mapOf(
          "toolName" to JsonPrimitive("executePlan"),
          "sessionUuid" to JsonPrimitive(sessionUuid),
        ),
      ),
      options.effectiveExecutePlanTimeoutMs(),
    )

  private fun toolEnableFailedOutcome(
    response: DaemonResponse,
    sessionUuid: String,
    acquired: Boolean,
  ): PlanAttemptOutcome {
    // Treat the prerequisite like executePlan itself: the retry classifier
    // below handles transient daemon responses rather than throwing before
    // it has a chance to retry the attempt.
    val outputPayload = PlanAttemptSupport.encodeOutputPayload(response)
    val parsed =
      parseDaemonToolResult(response, json).let {
        if (response.error.isNullOrBlank()) it.copy(errorMessage = "Unable to enable executePlan")
        else it
      }
    // executePlan never ran, so nothing holds this attempt's own acquisition for recovery.
    if (acquired) collaborators.sessionAcquirer.release(sessionUuid)
    return PlanAttemptOutcome(response, outputPayload, parsed, emptyList(), sessionUuid)
  }

  private fun runExecutePlan(
    request: PlanExecutionRequest,
    holdForRecovery: Boolean,
    sessionUuid: String,
    args: Map<String, JsonElement>,
    attempt: Int,
  ): PlanAttemptOutcome {
    val options = request.options
    val startStep = request.startStep
    if (options.debugMode) {
      println(
        "Executing plan via daemon socket: executePlan (startStep=$startStep, attempt=$attempt)",
      )
    }

    takenOverSession = null
    collaborators.heartbeat.registerSession(sessionUuid)
    val response =
      try {
        callDaemonToolForAttempt(
          "executePlan",
          JsonObject(args),
          options.effectiveExecutePlanTimeoutMs(),
        )
      } finally {
        collaborators.heartbeat.unregisterSession(sessionUuid)
      }
    val outputPayload = PlanAttemptSupport.encodeOutputPayload(response)
    val parsed = parseDaemonToolResult(response, json)
    val toolResults = parseToolResults(response, json, options.debugMode)
    if (PlanAttemptSupport.shouldReleaseAfterPlan(response, parsed, holdForRecovery)) {
      collaborators.sessionAcquirer.release(sessionUuid)
    }
    return PlanAttemptOutcome(response, outputPayload, parsed, toolResults, sessionUuid)
  }

  private fun callDaemonToolForAttempt(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse =
    try {
      collaborators.daemon.callTool(toolName, arguments, timeoutMs)
    } catch (error: DaemonUnavailableException) {
      DaemonResponse(
        id = "",
        type = "mcp_response",
        success = false,
        error = error.message ?: "daemon request timeout",
      )
    }

  private data class DeviceWaitProgress(var count: Int = 0, var elapsedMs: Long = 0)

  private fun waitForDevice(
    parsed: ParsedToolResult,
    errorMessage: String,
    sessionUuid: String?,
    holdForRecovery: Boolean,
    wait: DeviceWaitProgress,
  ): Boolean {
    val delayMs =
      deviceOwnedBackoffDelayMs(
        wait.count,
        wait.elapsedMs,
        parsed.retryAfterMs,
        parsed.code,
        collaborators.timings,
      )
    if (delayMs == null) return false
    val waitLead =
      if (parsed.code in RECOVERY_CODES) "Device is being recovered (${parsed.code})"
      else "Device is held by another session"
    println(
      "$waitLead; waiting ${delayMs}ms before retrying " +
        "(wait ${wait.count + 1}): $errorMessage",
    )
    if (holdForRecovery && sessionUuid != null) releaseHeldSession(sessionUuid)
    releaseTakenOverSession()
    collaborators.timings.deviceOwnedSleeper(delayMs)
    wait.count++
    wait.elapsedMs += delayMs
    return true
  }

  private fun releaseForRetry(holdForRecovery: Boolean, sessionUuid: String?) {
    if (holdForRecovery && sessionUuid != null) releaseHeldSession(sessionUuid)
    releaseTakenOverSession()
  }

  private companion object {
    private val json = Json { ignoreUnknownKeys = true }
  }
}
