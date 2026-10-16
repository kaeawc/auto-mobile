package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.ParsedToolResult
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.RECOVERY_CODES
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.RefusalDisposition
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.appendCaptureObserveStepsArgs
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.appendExecutePlanCleanupArgs
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.buildFailedStepContext
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.buildTestMetadata
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.detectTestContext
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.deviceOwnedBackoffDelayMs
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.deviceOwnedGiveUpMessage
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.isTransientError
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.loadAndProcessPlan
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.parseDaemonToolResult
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.parseToolResults
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.refusalDisposition
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.resolveCiMode
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.resolvePlanPath
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.resolveSecretConcreteValues
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutor.substituteParameters
import dev.jasonpearson.automobile.validation.ToolResultEntry
import java.io.File
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The production composition root; construction does not resolve the agent or open a connection.
 */
internal object PlanExecutors {
  fun default(
    collaborators: PlanExecutorCollaborators = PlanExecutorCollaborators(),
  ): PlanExecutor = PlanExecutor(collaborators)
}

/** Executes plans with parameter substitution, daemon integration, and AI-assisted recovery. */
internal class PlanExecutor(
  private val collaborators: PlanExecutorCollaborators = PlanExecutorCollaborators(),
) {
  private val agent by lazy { collaborators.agent() }

  /** Execute an AutoMobile plan with parameter substitution. */
  fun execute(
    planPath: String,
    parameters: Map<String, Any>,
    options: AutoMobilePlanExecutionOptions,
  ): AutoMobilePlanExecutionResult {

    val startTime = System.currentTimeMillis()

    try {
      // Resolve and validate the plan file path first, before any other checks
      val resolvedPlanPath = resolvePlanPath(planPath)

      // Check device availability after plan file validation
      if (!collaborators.deviceChecker.areDevicesAvailable()) {
        val executionTime = System.currentTimeMillis() - startTime
        return AutoMobilePlanExecutionResult(
          success = false,
          exitCode = -1,
          errorMessage = "No Android devices available for plan execution",
          executionTimeMs = executionTime,
          parametersUsed = parameters,
        )
      }

      // Read the RAW plan once. Derive the effective secret keys and the concrete strings to scrub
      // from THIS executor's own substitution — the single source of truth for what actually landed
      // in
      // the plan (#6029). Key names come from the RAW plan (placeholder-tolerant, immune to
      // substitution truncation) plus the caller config, with any `${...}` in the names resolved.
      val rawPlanContent = File(resolvedPlanPath).readText()
      val secretKeys =
        (options.secretParameterKeys + SecretRedactor.parsePlanSecretKeys(rawPlanContent))
          .map { substituteParameters(it, parameters) }
          .toSet()
      val secretValues =
        SecretRedactor.secretValues(resolveSecretConcreteValues(secretKeys, parameters))

      // Load and process the plan with parameter substitution
      val processedPlanContent = loadAndProcessPlan(rawPlanContent, parameters)

      if (options.debugMode) {
        println("Executing AutoMobile plan: $planPath")
        println("Parameters: ${SecretRedactor.redactParameters(parameters, secretKeys)}")
        // Redact substituted secret values out of the plan-content debug print too (#6029) —
        // otherwise
        // debugMode leaks them to logcat even though the LLM path is masked.
        println(
          "Processed plan content:\n${SecretRedactor.redact(processedPlanContent, secretValues)}",
        )
      }

      // Execute the processed plan
      val result = executeProcessedPlan(processedPlanContent, options, secretValues)

      val executionTime = System.currentTimeMillis() - startTime

      return AutoMobilePlanExecutionResult(
        success = result.success,
        exitCode = result.exitCode,
        output = result.output,
        errorMessage = result.errorMessage,
        executionTimeMs = executionTime,
        aiRecoveryAttempted = result.aiRecoveryAttempted,
        aiRecoverySuccessful = result.aiRecoverySuccessful,
        parametersUsed = parameters,
        toolResults = result.toolResults,
      )
    } catch (e: Exception) {
      val executionTime = System.currentTimeMillis() - startTime
      return AutoMobilePlanExecutionResult(
        success = false,
        exitCode = -1,
        errorMessage = "Plan execution failed: ${e.message}",
        executionTimeMs = executionTime,
        parametersUsed = parameters,
      )
    }
  }

  // ── Plan execution with recovery ──────────────────────────────────────────

  private fun executeProcessedPlan(
    planContent: String,
    options: AutoMobilePlanExecutionOptions,
    secretValues: List<String>,
  ): InternalExecutionResult {
    return executePlanFromStep(
      planContent,
      options,
      startStep = 0,
      recoveryAlreadyAttempted = false,
      secretValues = secretValues,
    )
  }

  /**
   * Execute a plan starting at [startStep]. If the plan fails and recovery has not yet been
   * attempted, the Koog agent is invoked to clear whatever interrupted the failed step. On
   * successful recovery the plan resumes by re-running the failed step (so its action is retried
   * now that the obstruction is gone) and then continuing. Recovery is allowed at most once per
   * test.
   */
  /**
   * @param deviceIdOverride When non-null, pins execution to this device. Used after recovery to
   *   ensure the resumed plan runs on the same device the agent just recovered.
   * @param sessionUuidOverride When non-null, the first attempt reuses this session instead of a
   *   fresh one: the failed attempt's session, which recovery also used, so the resumed plan is the
   *   device holder's own session rather than a stranger the daemon would refuse (#10783).
   */
  private fun executePlanFromStep(
    planContent: String,
    options: AutoMobilePlanExecutionOptions,
    startStep: Int,
    recoveryAlreadyAttempted: Boolean,
    secretValues: List<String>,
    deviceIdOverride: String? = null,
    sessionUuidOverride: String? = null,
  ): InternalExecutionResult {

    val json = Json { ignoreUnknownKeys = true }
    val maxRetries = options.maxRetries.coerceAtLeast(0)
    var attempt = 0
    var deviceOwnedWaitMs = 0L
    var deviceOwnedWaits = 0
    var attemptSessionUuid = sessionUuidOverride ?: UUID.randomUUID().toString()
    // When AI recovery may follow a failure, the daemon keeps the failed attempt's session and
    // device (#10834) so no other session can take the device between the attempt and recovery.
    // Every path that does not go on to recovery releases the held session itself.
    val holdForRecovery = recoveryMayFollow(options, recoveryAlreadyAttempted)
    // A resumed run takes over the session the daemon held for recovery. Until this run's
    // executePlan reaches the daemon, whose plan lifecycle then releases it, the runner still owns
    // that session: it releases it before switching to a fresh one or giving up, or the held
    // session blocks the device until its lease lapses (#11139).
    var takenOverSession: String? = sessionUuidOverride.takeIf { !holdForRecovery }
    val releaseTakenOverSession = {
      takenOverSession?.let { releaseHeldSession(it) }
      takenOverSession = null
    }

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

      // Opt this generated device session into executePlan before invoking it.
      response =
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
      if (!response.success) {
        // Treat the prerequisite like executePlan itself: the retry classifier
        // below handles transient daemon responses rather than throwing before
        // it has a chance to retry the attempt.
        outputPayload =
          response.result?.let { json.encodeToString(JsonElement.serializer(), it) } ?: ""
        parsed =
          parseDaemonToolResult(response, json).let {
            if (response.error.isNullOrBlank())
              it.copy(errorMessage = "Unable to enable executePlan")
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

      if (options.debugMode) {
        println("Daemon response:\n$outputPayload")
        if (!response.error.isNullOrBlank()) {
          println("Daemon error: ${response.error}")
        }
      }

      val success = response.success && parsed.success
      if (success) {
        return InternalExecutionResult(
          success = true,
          exitCode = 0,
          output = outputPayload,
          toolResults = toolResults,
        )
      }

      val errorMessage = response.error ?: parsed.errorMessage
      if (refusalDisposition(parsed) == RefusalDisposition.WAIT) {
        // Another session holds the device (typically a concurrent test attempt in this runner),
        // or its previous session is still finishing cleanup (#10960). Wait for it to free up,
        // within its own bounded budget, without spending maxRetries.
        val delayMs =
          deviceOwnedBackoffDelayMs(
            deviceOwnedWaits,
            deviceOwnedWaitMs,
            parsed.retryAfterMs,
            parsed.code,
            collaborators.timings,
          )
        if (delayMs == null) {
          parsed = parsed.copy(errorMessage = deviceOwnedGiveUpMessage(parsed, deviceOwnedWaitMs))
          break
        }
        val waitLead =
          if (parsed.code in RECOVERY_CODES) "Device is being recovered (${parsed.code})"
          else "Device is held by another session"
        println(
          "$waitLead; waiting ${delayMs}ms before retrying " +
            "(wait ${deviceOwnedWaits + 1}): $errorMessage",
        )
        if (holdForRecovery) releaseHeldSession(sessionUuid)
        releaseTakenOverSession()
        collaborators.timings.deviceOwnedSleeper(delayMs)
        deviceOwnedWaits++
        deviceOwnedWaitMs += delayMs
        // A refusal consumes no executePlan retry; the next pass is the same attempt number.
        attempt--
        attemptSessionUuid = UUID.randomUUID().toString()
        continue
      }
      if (
        attempt > maxRetries ||
          !(parsed.retryable ||
            parsed.acquireNewSession ||
            // An explicit `retryable: false` on a typed frame is the daemon's verdict (#11544); any
            // other failure falls back to matching the message text.
            (!parsed.terminal && isTransientError(errorMessage)))
      ) {
        break
      }

      // The retry is a fresh session; the held one would otherwise keep the device from it.
      if (holdForRecovery) releaseHeldSession(sessionUuid)
      releaseTakenOverSession()
      println("Retrying plan execution after transient error (attempt $attempt): $errorMessage")
      Thread.sleep(collaborators.timings.retryBackoffMs)
    }

    val failureMessage =
      if (parsed.code in RECOVERY_CODES) parsed.errorMessage
      else response.error ?: parsed.errorMessage

    // The daemon reports whether it actually kept the failed attempt's session (#11091): a plan
    // with derived device-label sessions is always released, so recovery would drive a device
    // this runner no longer holds. Fail now, with nothing to release.
    if (holdForRecovery && parsed.sessionHeld == false) {
      return sessionNotHeldFailure(
        sessionUuid = attemptSessionUuid,
        output = outputPayload,
        errorOutput = failureMessage,
        toolResults = toolResults,
      )
    }

    releaseTakenOverSession()
    // Non-transient failure or retries exhausted — attempt recovery if allowed
    val failedStepContext =
      buildFailedStepContext(response, json, planContent, options.device, secretValues)
        ?.copy(sessionUuid = attemptSessionUuid)
    return handleFailure(
      result = CommandResult(1, outputPayload, failureMessage),
      options = options,
      toolResults = toolResults,
      failedStepContext = failedStepContext,
      planContent = planContent,
      recoveryAlreadyAttempted = recoveryAlreadyAttempted,
      secretValues = secretValues,
      heldSessionUuid = attemptSessionUuid.takeIf { holdForRecovery },
    )
  }

  /** Whether a failure of this plan run would go on to AI recovery (see [handleFailure]). */
  private fun recoveryMayFollow(
    options: AutoMobilePlanExecutionOptions,
    recoveryAlreadyAttempted: Boolean,
  ): Boolean =
    options.aiAssistance &&
      !recoveryAlreadyAttempted &&
      !resolveCiMode() &&
      agent.recoveryConfigProvider.isRecoveryEnabled()

  /**
   * Release a session the daemon kept after a failed executePlan (`holdSessionOnFailure`, #10834)
   * once recovery will not resume it. Best-effort: if the release does not reach the daemon, the
   * session lapses at its heartbeat timeout because nothing heartbeats it any more.
   */
  private fun releaseHeldSession(sessionUuid: String) {
    val response =
      try {
        collaborators.daemon.callDaemonMethod(
          RELEASE_SESSION_METHOD,
          JsonObject(mapOf("sessionId" to JsonPrimitive(sessionUuid))),
          RELEASE_SESSION_TIMEOUT_MS,
        )
      } catch (error: DaemonUnavailableException) {
        DaemonResponse(id = "", type = "daemon_response", success = false, error = error.message)
      }
    if (!response.success) {
      println(
        "Warning: could not release held session $sessionUuid (${response.error}); it lapses " +
          "at its heartbeat timeout",
      )
    }
  }

  // ── Failure handling & recovery ───────────────────────────────────────────

  /**
   * The failure to report when the daemon answered a failed executePlan that asked to hold its
   * session with `sessionHeld: false` (#11091): it released the session and device, so AI recovery
   * is skipped rather than run on a device another session may already own.
   */
  private fun sessionNotHeldFailure(
    sessionUuid: String,
    output: String,
    errorOutput: String,
    toolResults: List<ToolResultEntry>,
  ): InternalExecutionResult {
    val reason =
      "AI recovery skipped: the daemon released session $sessionUuid after the failed plan " +
        "(sessionHeld: false; plans with derived device-label sessions are always released)"
    val errorMessage =
      "AutoMobile plan execution failed with exit code 1" +
        (if (errorOutput.isNotEmpty()) "\nErrors: $errorOutput" else "") +
        "\n$reason"
    System.err.println(errorMessage)
    return InternalExecutionResult(
      success = false,
      exitCode = 1,
      output = output,
      errorMessage = errorMessage,
      toolResults = toolResults,
    )
  }

  /**
   * The failure to report when the daemon released [sessionUuid] while the runner heartbeated it
   * (#11072), or null while the session is still held. The daemon already freed the session, so
   * there is nothing to release.
   */
  private fun sessionLossFailure(
    sessionUuid: String?,
    result: CommandResult,
    errorMessage: String,
    toolResults: List<ToolResultEntry>,
    recoveryAttempted: Boolean,
    releaseHeld: () -> Unit = {},
  ): InternalExecutionResult? {
    val loss = sessionUuid?.let { collaborators.heartbeat.sessionLoss(it) } ?: return null
    // An unconfirmed loss may be a session the daemon still holds: release it rather than leak it.
    if (!loss.confirmed) releaseHeld()
    val reason = "AI recovery cannot continue: ${loss.describe()}"
    System.err.println(reason)
    return InternalExecutionResult(
      success = false,
      exitCode = result.exitCode,
      output = result.output,
      errorMessage = "$errorMessage\n$reason",
      aiRecoveryAttempted = recoveryAttempted,
      aiRecoverySuccessful = false,
      toolResults = toolResults,
    )
  }

  private fun handleFailure(
    result: CommandResult,
    options: AutoMobilePlanExecutionOptions,
    toolResults: List<ToolResultEntry>,
    failedStepContext: FailedStepContext?,
    planContent: String,
    recoveryAlreadyAttempted: Boolean,
    secretValues: List<String>,
    heldSessionUuid: String? = null,
  ): InternalExecutionResult {
    // The daemon kept the failed attempt's session and device for recovery (#10834). Only the
    // resumed plan takes it over (and releases it); every other outcome releases it here.
    val releaseHeld = {
      if (heldSessionUuid != null) releaseHeldSession(heldSessionUuid)
    }

    val errorMessage =
      "AutoMobile plan execution failed with exit code ${result.exitCode}" +
        if (result.errorOutput.isNotEmpty()) "\nErrors: ${result.errorOutput}" else ""

    System.err.println(errorMessage)

    val ciMode = resolveCiMode()
    val recoveryFlagEnabled = agent.recoveryConfigProvider.isRecoveryEnabled()
    if (
      !options.aiAssistance ||
        !recoveryFlagEnabled ||
        ciMode ||
        recoveryAlreadyAttempted ||
        failedStepContext == null
    ) {
      if (recoveryAlreadyAttempted) {
        println("Recovery already attempted for this test — failing without retry")
      }
      if (!recoveryFlagEnabled) {
        println("AI recovery disabled via ai-recovery feature flag")
      }
      releaseHeld()
      return InternalExecutionResult(
        success = false,
        exitCode = result.exitCode,
        output = result.output,
        errorMessage = errorMessage,
        toolResults = toolResults,
      )
    }

    // Attempt Koog-powered recovery
    println(
      "Attempting AI-assisted recovery for failed step ${failedStepContext.failedStepIndex + 1} (${failedStepContext.failedTool})",
    )

    // Pass the resolved secret VALUES into the recovery agent so its loop can scrub the DYNAMIC
    // tool/observe results it feeds back to the LLM (issue #6094). The initial recovery prompt is
    // already redacted on FailedStepContext (#6092); this covers the second-order loop channel.
    // The failed attempt unregistered its session when executePlan returned; keep it heartbeating
    // while recovery's calls (which carry it) hold the device, or the daemon idle-releases it.
    val recoverySession = failedStepContext.sessionUuid
    // The daemon already released the failed attempt's session (#11072): recovery would drive a
    // device the runner no longer holds, so fail now with the daemon's reason.
    sessionLossFailure(
        recoverySession,
        result,
        errorMessage,
        toolResults,
        recoveryAttempted = false,
        releaseHeld = releaseHeld,
      )
      ?.let {
        return it
      }
    if (recoverySession != null) collaborators.heartbeat.registerSession(recoverySession)
    val recoveryOutcome =
      try {
        agent.attemptAiRecovery(
          failedStepContext,
          secretValues,
          collaborators.timings,
          collaborators.heartbeat,
        )
      } catch (error: Throwable) {
        releaseHeld()
        throw error
      } finally {
        if (recoverySession != null) collaborators.heartbeat.unregisterSession(recoverySession)
      }

    // Released while recovery ran: never resume on it, whatever recovery reported.
    sessionLossFailure(
        recoverySession,
        result,
        errorMessage,
        toolResults,
        recoveryAttempted = true,
        releaseHeld = releaseHeld,
      )
      ?.let {
        return it
      }

    if (!recoveryOutcome.success) {
      println("AI recovery failed")
      releaseHeld()
      return InternalExecutionResult(
        success = false,
        exitCode = result.exitCode,
        output = result.output,
        errorMessage = errorMessage,
        aiRecoveryAttempted = true,
        aiRecoverySuccessful = false,
        toolResults = toolResults,
      )
    }

    // Recovery only cleared whatever was blocking the failed step (a modal,
    // notification, permission dialog, etc.). The step's own action has NOT run yet, so
    // resume by RE-RUNNING the failed step itself — the daemon retries its action
    // deterministically and then continues with the rest of the plan. Resuming at
    // failedStepIndex + 1 would skip the step and leave the app on the wrong screen.
    //
    // This re-run is also the authoritative check that recovery worked: if the
    // obstruction is truly gone the step now passes; otherwise it fails again and the
    // once-per-test guard (recoveryAlreadyAttempted) stops us from looping. coerceAtLeast
    // guards the -1 "unknown step" case by re-running the whole plan from the start.
    val resumeStep = failedStepContext.failedStepIndex.coerceAtLeast(0)
    println("AI recovery succeeded, re-running failed step ${resumeStep + 1} and resuming")

    val resumeResult =
      executePlanFromStep(
        planContent = planContent,
        options = options,
        startStep = resumeStep,
        recoveryAlreadyAttempted = true, // prevent recursive recovery
        secretValues = secretValues,
        deviceIdOverride = failedStepContext.deviceId,
        sessionUuidOverride = failedStepContext.sessionUuid,
      )

    return InternalExecutionResult(
      success = resumeResult.success,
      exitCode = resumeResult.exitCode,
      output = resumeResult.output,
      errorMessage = resumeResult.errorMessage,
      aiRecoveryAttempted = true,
      aiRecoverySuccessful = resumeResult.success,
      toolResults = toolResults + resumeResult.toolResults,
    )
  }

  // ── Retry helpers ────────────────────────────────────────────────────────

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

  private data class InternalExecutionResult(
    val success: Boolean,
    val exitCode: Int,
    val output: String = "",
    val errorMessage: String = "",
    val aiRecoveryAttempted: Boolean = false,
    val aiRecoverySuccessful: Boolean = false,
    val toolResults: List<ToolResultEntry> = emptyList(),
  )

  private companion object {
    private const val RELEASE_SESSION_METHOD = "daemon/releaseSession"
    private const val RELEASE_SESSION_TIMEOUT_MS = 10_000L
  }
}
