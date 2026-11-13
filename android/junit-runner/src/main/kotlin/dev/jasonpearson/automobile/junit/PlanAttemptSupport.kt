package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import dev.jasonpearson.automobile.junit.DeviceWaitPolicy.isTransientError
import dev.jasonpearson.automobile.junit.PlanRequestOptions.appendCaptureObserveStepsArgs
import dev.jasonpearson.automobile.junit.PlanRequestOptions.appendExecutePlanCleanupArgs
import dev.jasonpearson.automobile.junit.PlanTestMetadata.buildTestMetadata
import dev.jasonpearson.automobile.junit.PlanTestMetadata.detectTestContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Stateless request, response and outcome helpers for [PlanAttemptLoop]. */
internal object PlanAttemptSupport {
  private val json = Json { ignoreUnknownKeys = true }

  /**
   * The configured device, `ANDROID_SERIAL`, or the device recovery just drove; null lets the
   * daemon choose.
   */
  fun effectiveDeviceId(
    request: PlanExecutionRequest,
    collaborators: PlanExecutorCollaborators,
  ): String? =
    request.deviceIdOverride
      ?: PlanDeviceSelection.resolveDeviceId(
        request.options.device,
        request.planContent,
        collaborators.environment,
      )

  fun buildArguments(
    request: PlanExecutionRequest,
    holdForRecovery: Boolean,
    sessionUuid: String,
    effectiveDeviceId: String?,
  ): MutableMap<String, JsonElement> {
    val planContent = request.planContent
    val startStep = request.startStep
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

    // Pin to the recovered device if specified, otherwise the configured device or ANDROID_SERIAL
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

  /**
   * The daemon keeps a session its caller held before the plan, so the runner releases it, except a
   * failed attempt held for AI recovery, whose release the recovery flow owns. A failure the daemon
   * reports as not held (`sessionHeld: false`) skips recovery, so its caller-held base is released
   * here too.
   */
  fun shouldReleaseAfterPlan(
    response: DaemonResponse,
    parsed: ParsedToolResult,
    holdForRecovery: Boolean,
  ): Boolean {
    val succeeded = response.success && parsed.success
    val heldForRecovery = holdForRecovery && parsed.sessionHeld != false
    return succeeded || !heldForRecovery
  }

  fun encodeOutputPayload(response: DaemonResponse): String =
    response.result?.let { json.encodeToString(JsonElement.serializer(), it) } ?: ""

  fun shouldRetry(parsed: ParsedToolResult, errorMessage: String): Boolean =
    parsed.retryable ||
      parsed.acquireNewSession ||
      (!parsed.terminal && isTransientError(errorMessage))

  fun logResponse(
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

  fun acquisitionFailedOutcome(
    acquisition: PlanSessionAcquisition.Failed,
  ): PlanAttemptOutcome =
    PlanAttemptOutcome(
      acquisition.response,
      acquisition.outputPayload,
      acquisition.parsed,
      emptyList(),
      null,
    )
}
