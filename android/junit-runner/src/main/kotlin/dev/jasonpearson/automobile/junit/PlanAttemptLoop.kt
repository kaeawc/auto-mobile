package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.RefusalDisposition
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.parseDaemonToolResult
import dev.jasonpearson.automobile.junit.DaemonToolResultParser.refusalDisposition
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.RECOVERY_CODES
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.deviceOwnedBackoffDelayMs
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.deviceOwnedGiveUpMessage
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.isTransientError
import dev.jasonpearson.automobile.junit.PlanRequestOptions.appendCaptureObserveStepsArgs
import dev.jasonpearson.automobile.junit.PlanRequestOptions.appendExecutePlanCleanupArgs
import dev.jasonpearson.automobile.junit.PlanTestMetadata.buildTestMetadata
import dev.jasonpearson.automobile.junit.PlanTestMetadata.detectTestContext
import dev.jasonpearson.automobile.junit.PlanToolResultsParser.parseToolResults
import dev.jasonpearson.automobile.validation.ToolResultEntry
import java.util.UUID
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
    val sessionUuidOverride = request.sessionUuidOverride
    val maxRetries = options.maxRetries.coerceAtLeast(0)
    var attempt = 0
    val wait = DeviceWaitProgress()
    var attemptSessionUuid = sessionUuidOverride ?: UUID.randomUUID().toString()
    // When AI recovery may follow a failure, the daemon keeps the failed attempt's session and
    // device (#10834) so no other session can take the device between the attempt and recovery.
    // Every path that does not go on to recovery releases the held session itself.
    // A resumed run takes over the session the daemon held for recovery. Until this run's
    // executePlan reaches the daemon, whose plan lifecycle then releases it, the runner still owns
    // that session: it releases it before switching to a fresh one or giving up, or the held
    // session blocks the device until its lease lapses (#11139).
    var response: DaemonResponse
    var outputPayload: String
    var parsed: ParsedToolResult
    var toolResults: List<ToolResultEntry>

    // Retry loop for transient failures (timeouts, daemon busy)
    while (true) {
      attempt++
      // Only the first attempt may reuse the failed attempt's session; a retry is a fresh one.
      val sessionUuid = if (attempt == 1) attemptSessionUuid else UUID.randomUUID().toString()
      attemptSessionUuid = sessionUuid

      val outcome = performAttempt(request, holdForRecovery, sessionUuid, attempt)
      response = outcome.response
      outputPayload = outcome.outputPayload
      parsed = outcome.parsed
      toolResults = outcome.toolResults

      logResponse(options, response, outputPayload)

      val success = response.success && parsed.success
      if (success) {
        return PlanAttemptOutcome(response, outputPayload, parsed, toolResults, attemptSessionUuid)
      }

      val errorMessage = response.error ?: parsed.errorMessage
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
        attemptSessionUuid = UUID.randomUUID().toString()
        continue
      }
      if (attempt > maxRetries || !shouldRetry(parsed, errorMessage)) {
        break
      }

      // The retry is a fresh session; the held one would otherwise keep the device from it.
      releaseForRetry(holdForRecovery, sessionUuid)
      println("Retrying plan execution after transient error (attempt $attempt): $errorMessage")
      Thread.sleep(collaborators.timings.retryBackoffMs)
    }

    return PlanAttemptOutcome(response, outputPayload, parsed, toolResults, attemptSessionUuid)
  }

  private fun performAttempt(
    request: PlanExecutionRequest,
    holdForRecovery: Boolean,
    sessionUuid: String,
    attempt: Int,
  ): PlanAttemptOutcome {
    val options = request.options
    val startStep = request.startStep
    val json = Json { ignoreUnknownKeys = true }
    val args = buildArguments(request, holdForRecovery, sessionUuid)
    // Opt this generated device session into executePlan before invoking it.
    val selectionResponse =
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
    var response = selectionResponse
    val outputPayload: String
    val parsed: ParsedToolResult
    val toolResults: List<ToolResultEntry>
    if (!response.success) {
      // Treat the prerequisite like executePlan itself: the retry classifier
      // below handles transient daemon responses rather than throwing before
      // it has a chance to retry the attempt.
      outputPayload =
        response.result?.let { json.encodeToString(JsonElement.serializer(), it) } ?: ""
      parsed =
        parseDaemonToolResult(response, json).let {
          if (response.error.isNullOrBlank()) it.copy(errorMessage = "Unable to enable executePlan")
          else it
        }
      toolResults = emptyList()
    } else {
      if (options.debugMode) {
        println(
          "Executing plan via daemon socket: executePlan (startStep=$startStep, attempt=$attempt)",
        )
      }

      takenOverSession = null
      collaborators.heartbeat.registerSession(sessionUuid)
      response =
        try {
          callDaemonToolForAttempt(
            "executePlan",
            JsonObject(args),
            options.effectiveExecutePlanTimeoutMs(),
          )
        } finally {
          collaborators.heartbeat.unregisterSession(sessionUuid)
        }
      outputPayload =
        response.result?.let { json.encodeToString(JsonElement.serializer(), it) } ?: ""
      parsed = parseDaemonToolResult(response, json)
      toolResults = parseToolResults(response, json, options.debugMode)
    }

    return PlanAttemptOutcome(response, outputPayload, parsed, toolResults, sessionUuid)
  }

  private fun buildArguments(
    request: PlanExecutionRequest,
    holdForRecovery: Boolean,
    sessionUuid: String,
  ): MutableMap<String, JsonElement> {
    val planContent = request.planContent
    val options = request.options
    val startStep = request.startStep
    val deviceIdOverride = request.deviceIdOverride
    val args =
      mutableMapOf<String, JsonElement>(
        "planContent" to
          JsonPrimitive(
            "base64:" + java.util.Base64.getEncoder().encodeToString(planContent.toByteArray()),
          ),
        "platform" to JsonPrimitive("android"),
        "startStep" to JsonPrimitive(startStep),
        "sessionUuid" to JsonPrimitive(sessionUuid),
      )

    // Pin to the recovered device if specified, otherwise use the configured device
    val effectiveDeviceId = deviceIdOverride ?: options.device.takeIf { it != "auto" }
    if (effectiveDeviceId != null) {
      args["deviceId"] = JsonPrimitive(effectiveDeviceId)
    }

    // Detect calling test context and include metadata for test run recording
    val testContext = detectTestContext()
    if (testContext != null) {
      args["testMetadata"] = buildTestMetadata(testContext)
    }

    appendExecutePlanCleanupArgs(args)
    appendCaptureObserveStepsArgs(args)
    if (holdForRecovery) {
      args["holdSessionOnFailure"] = JsonPrimitive(true)
    }

    return args
  }

  private fun shouldRetry(parsed: ParsedToolResult, errorMessage: String): Boolean =
    parsed.retryable ||
      parsed.acquireNewSession ||
      (!parsed.terminal && isTransientError(errorMessage))

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
    sessionUuid: String,
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
    if (holdForRecovery) releaseHeldSession(sessionUuid)
    releaseTakenOverSession()
    collaborators.timings.deviceOwnedSleeper(delayMs)
    wait.count++
    wait.elapsedMs += delayMs
    return true
  }

  private fun logResponse(
    options: AutoMobilePlanExecutionOptions,
    response: DaemonResponse,
    outputPayload: String,
  ) {
    if (options.debugMode) {
      println("Daemon response:\n$outputPayload")
      if (!response.error.isNullOrBlank()) {
        println("Daemon error: ${response.error}")
      }
    }
  }

  private fun releaseForRetry(holdForRecovery: Boolean, sessionUuid: String) {
    if (holdForRecovery) releaseHeldSession(sessionUuid)
    releaseTakenOverSession()
  }
}
