package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.ToolResult
import dev.jasonpearson.automobile.validation.ToolResultEntry
import dev.jasonpearson.automobile.validation.ToolResultParser
import java.io.File
import java.util.UUID
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * Internal executor class that handles the actual execution of AutoMobile plans with parameter
 * substitution, daemon socket integration, and AI-assisted recovery via Koog.
 */
internal object AutoMobilePlanExecutor {

  /** Injectable agent for testing. When null, uses [LazyInitializer.getAgent]. */
  @JvmStatic internal var testAgent: AutoMobileAgent? = null

  private val agent: AutoMobileAgent
    get() = testAgent ?: LazyInitializer.getAgent()

  /** Detected test context from stack trace inspection. */
  private data class TestContext(val className: String, val methodName: String)

  /**
   * Detect the calling test class and method from the current stack trace. Looks for methods
   * annotated with @Test by inspecting the call stack.
   */
  private fun detectTestContext(): TestContext? {
    val stackTrace = Thread.currentThread().stackTrace

    for (element in stackTrace) {
      // Skip internal classes
      if (
        element.className.startsWith("java.") ||
          element.className.startsWith("kotlin.") ||
          element.className.startsWith("jdk.") ||
          element.className.startsWith("sun.") ||
          element.className.contains("AutoMobilePlan")
      ) {
        continue
      }

      try {
        val clazz = Class.forName(element.className)
        val methods = clazz.declaredMethods

        for (method in methods) {
          if (method.name == element.methodName && method.isAnnotationPresent(Test::class.java)) {
            // Found a @Test annotated method in the call stack
            // Fully qualified: two `SmokeTest` classes in different packages must not share one
            // (test_class, test_method) history (#10091).
            return TestContext(clazz.name, method.name)
          }
        }
      } catch (_: ClassNotFoundException) {
        // Class not found, skip
      } catch (_: NoClassDefFoundError) {
        // Class definition error, skip
      }
    }

    return null
  }

  /** Build test metadata JSON object for the daemon request. */
  private fun buildTestMetadata(testContext: TestContext): JsonObject {
    val metadata =
      mutableMapOf<String, JsonElement>(
        "testClass" to JsonPrimitive(testContext.className),
        "testMethod" to JsonPrimitive(testContext.methodName),
        "isCi" to JsonPrimitive(resolveCiMode()),
      )

    // Add optional metadata if available
    val appVersion =
      firstNonBlank(
        System.getProperty("automobile.app.version", ""),
        System.getenv("AUTOMOBILE_APP_VERSION"),
        System.getenv("APP_VERSION"),
      )
    if (appVersion != null) {
      metadata["appVersion"] = JsonPrimitive(appVersion)
    }

    val gitCommit =
      firstNonBlank(
        System.getProperty("automobile.git.commit", ""),
        System.getenv("AUTOMOBILE_GIT_COMMIT"),
        System.getenv("GITHUB_SHA"),
        System.getenv("GIT_COMMIT"),
        System.getenv("CI_COMMIT_SHA"),
      )
    if (gitCommit != null) {
      metadata["gitCommit"] = JsonPrimitive(gitCommit)
    }

    val targetSdk =
      firstNonBlank(
          System.getProperty("automobile.android.targetSdk", ""),
          System.getProperty("automobile.targetSdk", ""),
          System.getenv("AUTOMOBILE_TARGET_SDK"),
          System.getenv("ANDROID_TARGET_SDK"),
        )
        ?.toIntOrNull()
    if (targetSdk != null) {
      metadata["targetSdk"] = JsonPrimitive(targetSdk)
    }

    val jdkVersion =
      firstNonBlank(
        System.getProperty("java.version"),
        System.getProperty("java.runtime.version"),
      )
    if (jdkVersion != null) {
      metadata["jdkVersion"] = JsonPrimitive(jdkVersion)
    }

    val jvmTarget =
      firstNonBlank(
        System.getProperty("kotlin.jvm.target"),
        System.getProperty("java.specification.version"),
      )
    if (jvmTarget != null) {
      metadata["jvmTarget"] = JsonPrimitive(jvmTarget)
    }

    val gradleVersion =
      firstNonBlank(
        System.getProperty("org.gradle.version"),
        System.getProperty("gradle.version"),
      )
    if (gradleVersion != null) {
      metadata["gradleVersion"] = JsonPrimitive(gradleVersion)
    }

    return JsonObject(metadata)
  }

  private fun resolveCiMode(): Boolean {
    val sysProp = System.getProperty("automobile.ci.mode")
    if (sysProp != null) {
      // Explicit system property takes precedence over environment
      return sysProp.toBoolean()
    }
    val envValue = System.getenv("CI") ?: return false
    return envValue.equals("true", ignoreCase = true) || envValue == "1"
  }

  private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }
  }

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
      if (!AutoMobileSharedUtils.deviceChecker.areDevicesAvailable()) {
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

  private fun resolvePlanPath(planPath: String): String {
    // Try to find the plan in test resources first
    val classLoader = Thread.currentThread().contextClassLoader
    val resource = classLoader.getResource(planPath)

    if (resource != null) {
      return File(resource.toURI()).path
    }

    // If not found in resources, try as absolute path
    val file = File(planPath)
    if (file.exists()) {
      return file.absolutePath
    }

    throw IllegalArgumentException("YAML plan not found: $planPath")
  }

  private fun loadAndProcessPlan(planContent: String, parameters: Map<String, Any>): String {
    // Substituted on the parsed YAML tree, not the source text, so a value cannot alter the plan
    // (#10093).
    val processedContent = PlanParameterSubstitution.substitutePlan(planContent, parameters)

    // Validate YAML schema after parameter substitution
    val validationResult = PlanSchemaValidator.validateYaml(processedContent)
    if (!validationResult.valid) {
      val errorMessages =
        validationResult.errors.joinToString("\n") { err ->
          val location = if (err.line != null) " (line ${err.line})" else ""
          "${err.field}: ${err.message}$location"
        }
      throw IllegalArgumentException(
        "Plan YAML validation failed:\n$errorMessages\n\n" +
          "The plan does not conform to the AutoMobile test plan schema. " +
          "Check schemas/test-plan.schema.json for details.",
      )
    }

    return processedContent
  }

  /**
   * Substitute `${key}` placeholders in a plain string (secret key names, the redaction path's bare
   * `${key}`) in a single pass that never rescans substituted text. The plan itself is substituted
   * on the parsed YAML tree by [PlanParameterSubstitution.substitutePlan] (#10093). Kept in sync
   * with the iOS executor's substitution.
   */
  private fun substituteParameters(content: String, parameters: Map<String, Any>): String =
    PlanParameterSubstitution.substituteText(content, parameters)

  /**
   * The concrete secret strings to scrub, derived entirely from THIS executor's substitution so
   * they always equal what landed in the recovery context (#6029). For each secret key: its raw
   * parameter value and its actual substituted value (`substituteParameters` applied to the bare
   * `${key}`, matching the ordered single pass exactly — no independent fixpoint, so a
   * self-referential value cannot blow up). Blank/unchanged results are dropped.
   */
  private fun resolveSecretConcreteValues(
    secretKeys: Set<String>,
    parameters: Map<String, Any>,
  ): List<String> {
    if (secretKeys.isEmpty()) return emptyList()
    // Raw parameter values via the lenient/fail-safe matcher (so an exotically-encoded key name
    // cannot
    // leak), plus each key's actual substituted value from this executor's ordered pass.
    val values = SecretRedactor.secretParameterValues(secretKeys, parameters).toMutableList()
    for (key in secretKeys) {
      val placeholder = "\${$key}"
      val landed = substituteParameters(placeholder, parameters)
      if (landed != placeholder && landed.isNotEmpty()) values.add(landed)
    }
    return values
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
          ParsedToolResult(
            false,
            response.error ?: "Unable to enable executePlan",
          )
        toolResults = emptyList()
      } else {
        if (options.debugMode) {
          println(
            "Executing plan via daemon socket: executePlan (startStep=$startStep, attempt=$attempt)",
          )
        }

        DaemonHeartbeat.registerSession(sessionUuid)
        response =
          try {
            callDaemonToolForAttempt(
              "executePlan",
              JsonObject(args),
              options.effectiveExecutePlanTimeoutMs(),
            )
          } finally {
            DaemonHeartbeat.unregisterSession(sessionUuid)
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
      if (parsed.code in DEVICE_WAIT_CODES) {
        // Another session holds the device (typically a concurrent test attempt in this runner),
        // or its previous session is still finishing cleanup (#10960). Wait for it to free up,
        // within its own bounded budget, without spending maxRetries.
        val delayMs = deviceOwnedBackoffDelayMs(deviceOwnedWaits, deviceOwnedWaitMs)
        if (delayMs == null) {
          parsed = parsed.copy(errorMessage = deviceOwnedGiveUpMessage(parsed, deviceOwnedWaitMs))
          break
        }
        println(
          "Device is held by another session; waiting ${delayMs}ms before retrying " +
            "(wait ${deviceOwnedWaits + 1}): $errorMessage",
        )
        if (holdForRecovery) releaseHeldSession(sessionUuid)
        deviceOwnedSleeper(delayMs)
        deviceOwnedWaits++
        deviceOwnedWaitMs += delayMs
        // A refusal consumes no executePlan retry; the next pass is the same attempt number.
        attempt--
        attemptSessionUuid = UUID.randomUUID().toString()
        continue
      }
      if (attempt > maxRetries || !(parsed.retryable || isTransientError(errorMessage))) {
        break
      }

      // The retry is a fresh session; the held one would otherwise keep the device from it.
      if (holdForRecovery) releaseHeldSession(sessionUuid)
      println("Retrying plan execution after transient error (attempt $attempt): $errorMessage")
      Thread.sleep(retryBackoffMs)
    }

    // Non-transient failure or retries exhausted — attempt recovery if allowed
    val failedStepContext =
      buildFailedStepContext(response, json, planContent, options.device, secretValues)
        ?.copy(sessionUuid = attemptSessionUuid)
    return handleFailure(
      result = CommandResult(1, outputPayload, response.error ?: parsed.errorMessage),
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
        DaemonSocketClientManager.callDaemonMethod(
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
  ): InternalExecutionResult? {
    val loss = sessionUuid?.let { DaemonHeartbeat.sessionLoss(it) } ?: return null
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
    val releaseHeld = { if (heldSessionUuid != null) releaseHeldSession(heldSessionUuid) }

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
      )
      ?.let {
        return it
      }
    if (recoverySession != null) DaemonHeartbeat.registerSession(recoverySession)
    val recoveryOutcome =
      try {
        agent.attemptAiRecovery(failedStepContext, secretValues)
      } catch (error: Throwable) {
        releaseHeld()
        throw error
      } finally {
        if (recoverySession != null) DaemonHeartbeat.unregisterSession(recoverySession)
      }

    // Released while recovery ran: never resume on it, whatever recovery reported.
    sessionLossFailure(recoverySession, result, errorMessage, toolResults, recoveryAttempted = true)
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

  // ── Build FailedStepContext from daemon response ──────────────────────────

  private fun buildFailedStepContext(
    response: DaemonResponse,
    json: Json,
    planContent: String,
    deviceId: String?,
    secretValues: List<String>,
  ): FailedStepContext? {
    try {
      val resultElement = response.result ?: return null
      val contentArray = resultElement.jsonObject["content"] as? JsonArray ?: return null
      val contentText =
        contentArray
          .firstOrNull { element ->
            (element as? JsonObject)?.get("type")?.jsonPrimitive?.content == "text"
          }
          ?.jsonObject
          ?.get("text")
          ?.jsonPrimitive
          ?.content ?: return null
      val payload = json.parseToJsonElement(contentText).jsonObject

      val failedStepObj = payload["failedStep"]?.jsonObject ?: return null
      val failedStepIndex =
        failedStepObj["stepIndex"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
      val failedTool = failedStepObj["tool"]?.jsonPrimitive?.content ?: "unknown"
      val error = failedStepObj["error"]?.jsonPrimitive?.content ?: "Unknown error"
      val resolvedDeviceId =
        resolveFailedStepDeviceId(
          payload = payload,
          failedStepObj = failedStepObj,
          configuredDeviceId = deviceId,
        )

      // Build succeeded steps from toolResults in the payload
      val succeededSteps = mutableListOf<SucceededStepSummary>()
      val toolResultsArray = (payload["toolResults"] ?: payload["toolResult"]) as? JsonArray
      if (toolResultsArray != null) {
        for ((position, stepElement) in toolResultsArray.withIndex()) {
          val stepObj = stepElement as? JsonObject ?: continue
          // The daemon reports completed steps only, tagged with the plan step index, so a
          // skipped optional step leaves a gap; fall back to the position for untagged entries.
          val index = (stepObj["stepIndex"] as? JsonPrimitive)?.intOrNull ?: position
          if (index >= failedStepIndex) continue
          val tool =
            stepObj["toolName"]?.jsonPrimitive?.content
              ?: stepObj["tool"]?.jsonPrimitive?.content
              ?: "unknown"
          // A step's tool can be a substituted `${secret}` value, so scrub the name too (#6029).
          succeededSteps.add(
            SucceededStepSummary(
              stepIndex = index,
              tool = SecretRedactor.redact(tool, secretValues),
            ),
          )
        }
      }

      // Egress boundary (issue #6029): FailedStepContext.planContent, error, and the (possibly
      // substituted) tool names are embedded verbatim into the recovery prompt sent to the LLM
      // provider (see AutoMobileAgent.attemptAiRecovery), so mask secret values out of them here.
      // The daemon's base64 payload above kept the real values.
      return FailedStepContext(
        failedStepIndex = failedStepIndex,
        failedTool = SecretRedactor.redact(failedTool, secretValues),
        error = SecretRedactor.redact(error, secretValues),
        succeededSteps = succeededSteps,
        planContent = SecretRedactor.redact(planContent, secretValues),
        deviceId = resolvedDeviceId,
      )
    } catch (e: Exception) {
      println("Warning: Failed to build recovery context: ${e.message}")
      return null
    }
  }

  /**
   * The real device id the failed step ran on, for pinning the recovery and the resumed plan.
   *
   * `failedStep.device` is the plan's device LABEL ("A"), never an id, so it is only a key into the
   * payload's `deviceMapping` (label -> id, multi-device plans). A single-device plan has no label
   * and ran on the payload's top-level `deviceId`. A label with no mapping entry yields null (no
   * pin) rather than the label or another track's device. [configuredDeviceId] is the id the test
   * asked for, used only when the payload carries none.
   */
  private fun resolveFailedStepDeviceId(
    payload: JsonObject,
    failedStepObj: JsonObject,
    configuredDeviceId: String?,
  ): String? {
    val label = (failedStepObj["device"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (label != null) {
      val mapping = payload["deviceMapping"] as? JsonObject
      return (mapping?.get(label) as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
    val executedOn = (payload["deviceId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return executedOn?.takeIf { it.isNotBlank() }
      ?: configuredDeviceId?.takeIf { it.isNotBlank() && it != "auto" }
  }

  // ── Response parsing ──────────────────────────────────────────────────────

  private fun parseDaemonToolResult(response: DaemonResponse, json: Json): ParsedToolResult {
    if (!response.success) {
      return ParsedToolResult(false, response.error ?: "Daemon returned failure")
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
    val errorObject = parsed["error"] as? JsonObject
    val retryable =
      errorObject?.get("retryable") == JsonPrimitive(true) ||
        parsed["retryable"] == JsonPrimitive(true)
    if (isError || parsed.containsKey("error") || !success) {
      // The typed `code` (never the message) is what clients match on.
      val code =
        ((errorObject?.get("code") ?: parsed["code"]) as? JsonPrimitive)
          ?.takeIf { it.isString }
          ?.content
      val daemonMessage = (parsed["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
      return ParsedToolResult(
        false,
        planFailureMessage(parsed, isError),
        retryable,
        code,
        daemonMessage,
      )
    }
    return ParsedToolResult(true, "")
  }

  private fun planFailureMessage(payload: JsonObject, isError: Boolean): String {
    val errorObject = payload["error"] as? JsonObject
    val failedStepObj = payload["failedStep"] as? JsonObject
    if (failedStepObj != null && errorObject == null && payload["code"] == null) {
      val stepIndex = (failedStepObj["stepIndex"] as? JsonPrimitive)?.intOrNull ?: 0
      val tool = (failedStepObj["tool"] as? JsonPrimitive)?.content ?: "unknown"
      val stepError = (failedStepObj["error"] as? JsonPrimitive)?.content ?: "Unknown step error"
      val executedSteps = (payload["executedSteps"] as? JsonPrimitive)?.intOrNull
      val totalSteps = (payload["totalSteps"] as? JsonPrimitive)?.intOrNull
      return buildString {
        append("Test plan execution failed at step ${stepIndex + 1} ($tool):")
        append("\n  Error: $stepError")
        if (executedSteps != null && totalSteps != null) {
          append("\n  Executed: $executedSteps/$totalSteps steps")
        }
      }
    }
    val daemonError = errorObject ?: payload
    val details =
      listOfNotNull(
        (daemonError["code"] as? JsonPrimitive)?.content,
        (daemonError["message"] as? JsonPrimitive)?.content,
        (daemonError["deviceId"] as? JsonPrimitive)?.content,
      )
    if (errorObject != null || payload.containsKey("code") || payload.containsKey("message")) {
      if (details.isNotEmpty()) return details.joinToString(": ")
    }

    return (payload["error"] as? JsonPrimitive)?.content
      ?: when {
        isError -> "Daemon tool returned an error: $payload"
        payload["success"] == JsonPrimitive(false) -> "AutoMobile plan failed"
        else -> "Daemon result did not confirm plan success: $payload"
      }
  }

  private fun parseToolResults(
    response: DaemonResponse,
    json: Json,
    debugMode: Boolean,
  ): List<ToolResultEntry> {
    return try {
      val resultElement = response.result ?: return emptyList()
      val contentArray = resultElement.jsonObject["content"] as? JsonArray ?: return emptyList()
      val contentText =
        contentArray
          .firstOrNull { element ->
            (element as? JsonObject)?.get("type")?.jsonPrimitive?.content == "text"
          }
          ?.jsonObject
          ?.get("text")
          ?.jsonPrimitive
          ?.content ?: return emptyList()
      val payload = json.parseToJsonElement(contentText).jsonObject
      val stepsElement = payload["toolResults"] ?: payload["toolResult"] ?: return emptyList()
      val stepsArray = stepsElement as? JsonArray ?: return emptyList()

      stepsArray.mapIndexed { index, stepElement ->
        parseToolResultStep(index, stepElement, debugMode)
      }
    } catch (e: Exception) {
      if (debugMode) {
        println("Warning: Failed to parse tool results: ${e.message}")
      }
      listOf(
        buildErrorToolResult(
          stepIndex = -1,
          toolName = null,
          errorMessage = e.message ?: "Failed to parse tool results",
        ),
      )
    }
  }

  private fun parseToolResultStep(
    stepIndex: Int,
    stepElement: JsonElement,
    debugMode: Boolean,
  ): ToolResultEntry {
    val stepObject =
      stepElement as? JsonObject
        ?: return buildErrorToolResult(
          stepIndex = stepIndex,
          toolName = null,
          errorMessage = "Tool result is not a JSON object",
          payload = stepElement,
        )
    val toolName =
      stepObject["toolName"]?.jsonPrimitive?.content
        ?: stepObject["tool"]?.jsonPrimitive?.content
        ?: stepObject["name"]?.jsonPrimitive?.content

    val resolvedStepIndex =
      (stepObject["stepIndex"] as? JsonPrimitive)?.intOrNull
        ?: (stepObject["index"] as? JsonPrimitive)?.intOrNull
        ?: stepIndex

    if (toolName.isNullOrBlank()) {
      val errorMessage =
        extractErrorMessage(stepObject) ?: "Missing tool name for step $resolvedStepIndex"
      if (debugMode) {
        println("Warning: $errorMessage")
      }
      return buildErrorToolResult(
        stepIndex = resolvedStepIndex,
        toolName = null,
        errorMessage = errorMessage,
        payload = stepObject,
      )
    }

    val responseElement =
      stepObject["response"]
        ?: stepObject["result"]
        ?: stepObject["payload"]
        ?: stepObject["output"]

    return try {
      when {
        responseElement != null ->
          parseToolResultElement(resolvedStepIndex, toolName, responseElement)
        stepObject["content"] != null ->
          ToolResultParser.parseToolResultFromMcpResponse(
            resolvedStepIndex,
            toolName,
            stepObject,
          )
        else -> ToolResultParser.parseToolResult(resolvedStepIndex, toolName, stepObject)
      }
    } catch (e: Exception) {
      val errorMessage =
        extractErrorMessage(stepObject, responseElement)
          ?: e.message
          ?: "Failed to parse tool result"
      if (debugMode) {
        println("Warning: Failed to parse tool result at step $resolvedStepIndex: $errorMessage")
      }
      buildErrorToolResult(
        stepIndex = resolvedStepIndex,
        toolName = toolName,
        errorMessage = errorMessage,
        payload = stepObject,
      )
    }
  }

  private fun parseToolResultElement(
    stepIndex: Int,
    toolName: String,
    element: JsonElement,
  ): ToolResult {
    return when (element) {
      is JsonObject ->
        if (element.containsKey("content")) {
          ToolResultParser.parseToolResultFromMcpResponse(stepIndex, toolName, element)
        } else {
          ToolResultParser.parseToolResult(stepIndex, toolName, element)
        }
      is JsonPrimitive -> ToolResultParser.parseToolResult(stepIndex, toolName, element.content)
      else -> ToolResultParser.parseToolResult(stepIndex, toolName, element)
    }
  }

  private fun buildErrorToolResult(
    stepIndex: Int,
    toolName: String?,
    errorMessage: String,
    payload: JsonElement? = null,
  ): ErrorToolResult {
    return ErrorToolResult(
      stepIndex = stepIndex,
      toolName = toolName,
      errorMessage = errorMessage,
      payload = payload,
    )
  }

  private fun extractErrorMessage(
    stepObject: JsonObject,
    responseElement: JsonElement? = null,
  ): String? {
    val stepError = (stepObject["error"] as? JsonPrimitive)?.content
    if (!stepError.isNullOrBlank()) {
      return stepError
    }
    val responseError = (responseElement as? JsonObject)?.get("error") as? JsonPrimitive
    return responseError?.content
  }

  /**
   * Optional `executePlan` post-run cleanup (daemon `toolRegistry` `finally`). Read fresh on each
   * build so per-test property changes apply (not cached via `SystemPropertyCache`).
   *
   * **System properties** (take precedence when set):
   * - `automobile.junit.executePlan.cleanupAppId` — non-blank package → daemon cleanup after plan
   * - `automobile.junit.executePlan.cleanupClearAppData` — `true` / `1` → clear app data; unset or
   *   false → force-stop only
   *
   * **Environment** (used when the property is unset for that field):
   * - `AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID`
   * - `AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA` — `true` / `1` / `yes`
   *
   * This is intentionally **not** on `AutoMobilePlanExecutionOptions` so apps can keep compiling
   * against an older published runner while CI jobs that publish a newer JAR get the behavior.
   */
  private fun appendExecutePlanCleanupArgs(args: MutableMap<String, JsonElement>) {
    val cleanupAppId = resolveExecutePlanCleanupAppId()
    if (cleanupAppId.isEmpty()) {
      return
    }
    args["cleanupAppId"] = JsonPrimitive(cleanupAppId)
    if (resolveExecutePlanCleanupClearAppData()) {
      args["cleanupClearAppData"] = JsonPrimitive(true)
    }
  }

  private fun resolveExecutePlanCleanupAppId(): String {
    val prop = System.getProperty("automobile.junit.executePlan.cleanupAppId")?.trim().orEmpty()
    if (prop.isNotEmpty()) {
      return prop
    }
    return System.getenv("AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID")?.trim().orEmpty()
  }

  private fun resolveExecutePlanCleanupClearAppData(): Boolean {
    val propRaw = System.getProperty("automobile.junit.executePlan.cleanupClearAppData")
    if (propRaw != null) {
      val t = propRaw.trim()
      return t.equals("true", ignoreCase = true) || t == "1"
    }
    val env =
      System.getenv("AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA")?.trim()?.lowercase().orEmpty()
    return env == "true" || env == "1" || env == "yes"
  }

  internal const val CAPTURE_OBSERVE_STEPS_PROPERTY =
    "automobile.junit.executePlan.captureObserveSteps"
  internal const val CAPTURE_OBSERVE_STEPS_ENV = "AUTOMOBILE_EXECUTE_PLAN_CAPTURE_OBSERVE_STEPS"

  /**
   * When set, the daemon attaches each successful `observe` step to `executePlan` `debug` (see
   * AutoMobile `captureObserveSteps`). Single-device plans only.
   *
   * **System property:** [CAPTURE_OBSERVE_STEPS_PROPERTY] — `summary` or `full`
   *
   * **Environment:** [CAPTURE_OBSERVE_STEPS_ENV] (same values)
   */
  private fun appendCaptureObserveStepsArgs(args: MutableMap<String, JsonElement>) {
    val v = resolveCaptureObserveSteps() ?: return
    args["captureObserveSteps"] = JsonPrimitive(v)
  }

  /**
   * Resolves the `captureObserveSteps` mode from system property (preferred) or environment
   * variable. Returns `null` if unset or set to an unrecognized value.
   */
  @JvmStatic
  internal fun resolveCaptureObserveSteps(): String? {
    val v =
      System.getProperty(CAPTURE_OBSERVE_STEPS_PROPERTY)?.trim()?.lowercase()
        ?: System.getenv(CAPTURE_OBSERVE_STEPS_ENV)?.trim()?.lowercase()
        ?: return null
    return v.takeIf { it == "summary" || it == "full" }
  }

  // ── Retry helpers ────────────────────────────────────────────────────────

  private const val RETRY_BACKOFF_MS = 2000L
  @JvmStatic internal var retryBackoffMs: Long = RETRY_BACKOFF_MS

  private fun callDaemonToolForAttempt(
    toolName: String,
    arguments: JsonObject,
    timeoutMs: Long,
  ): DaemonResponse =
    try {
      DaemonSocketClientManager.callTool(toolName, arguments, timeoutMs)
    } catch (error: DaemonUnavailableException) {
      DaemonResponse(
        id = "",
        type = "mcp_response",
        success = false,
        error = error.message ?: "daemon request timeout",
      )
    }

  /** Typed code for a device-mutating call refused because another session holds it (#10783). */
  internal const val DEVICE_OWNED_BY_OTHER_SESSION_CODE = "device_owned_by_other_session"

  /**
   * Typed code for a bind refused while the device's previous session finishes cleanup (#10960).
   */
  internal const val DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress"

  /** Typed code for a bind refused because another AutoMobile daemon claims the device (#10980). */
  internal const val DEVICE_OWNED_BY_OTHER_DAEMON_CODE = "device_owned_by_other_daemon"

  /** Refusals the runner waits out with the bounded held-device wait. */
  private val DEVICE_WAIT_CODES =
    setOf(
      DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      DEVICE_CLEANUP_IN_PROGRESS_CODE,
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
    )

  private const val DEVICE_OWNED_INITIAL_DELAY_MS = 500L
  private const val DEVICE_OWNED_MAX_DELAY_MS = 4_000L
  private const val DEVICE_OWNED_DEFAULT_BUDGET_MS = 30_000L

  /** Total time to wait for another session to release the device before giving up. */
  @JvmStatic internal var deviceOwnedWaitBudgetMs: Long = DEVICE_OWNED_DEFAULT_BUDGET_MS

  /** Seam over [Thread.sleep] so the device-held wait is instant in tests. */
  @JvmStatic internal var deviceOwnedSleeper: (Long) -> Unit = { Thread.sleep(it) }

  /**
   * Exponential delay (500ms doubling, capped at 4s) for the next wait on a held device, clamped to
   * the remaining [deviceOwnedWaitBudgetMs]; null once the budget is spent.
   */
  internal fun deviceOwnedBackoffDelayMs(waitsSoFar: Int, waitedMs: Long): Long? {
    val remaining = deviceOwnedWaitBudgetMs - waitedMs
    if (remaining <= 0) return null
    val doubled = DEVICE_OWNED_INITIAL_DELAY_MS shl waitsSoFar.coerceAtMost(8)
    return minOf(doubled, DEVICE_OWNED_MAX_DELAY_MS, remaining)
  }

  private const val RELEASE_SESSION_METHOD = "daemon/releaseSession"
  private const val RELEASE_SESSION_TIMEOUT_MS = 10_000L

  private fun deviceOwnedGiveUpMessage(parsed: ParsedToolResult, waitedMs: Long): String =
    (when (parsed.code) {
      DEVICE_CLEANUP_IN_PROGRESS_CODE ->
        "Device is still finishing its previous session's cleanup ($DEVICE_CLEANUP_IN_PROGRESS_CODE)"
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE ->
        "Device is claimed by another AutoMobile daemon ($DEVICE_OWNED_BY_OTHER_DAEMON_CODE)"
      else -> "Device is held by another session ($DEVICE_OWNED_BY_OTHER_SESSION_CODE)"
    }) +
      (parsed.daemonMessage?.let { ": $it" } ?: "") +
      "\nThe runner waited ${waitedMs}ms for it to be released. Another test attempt or tool " +
      "session is using this device; give each concurrent test its own device, or run them " +
      "serially."

  private fun isTransientError(errorMessage: String?): Boolean {
    if (errorMessage.isNullOrBlank()) return false
    val normalized = errorMessage.lowercase()
    return normalized.contains("request timed out") ||
      normalized.contains("plan execution in progress") ||
      normalized.contains("daemon request timeout")
  }

  // ── Internal types ────────────────────────────────────────────────────────

  private data class InternalExecutionResult(
    val success: Boolean,
    val exitCode: Int,
    val output: String = "",
    val errorMessage: String = "",
    val aiRecoveryAttempted: Boolean = false,
    val aiRecoverySuccessful: Boolean = false,
    val toolResults: List<ToolResultEntry> = emptyList(),
  )

  private data class ParsedToolResult(
    val success: Boolean,
    val errorMessage: String,
    val retryable: Boolean = false,
    /** The daemon's typed error `code`, when it sent one. */
    val code: String? = null,
    /** The daemon's human-readable `error` string, when it sent one. */
    val daemonMessage: String? = null,
  )
}
