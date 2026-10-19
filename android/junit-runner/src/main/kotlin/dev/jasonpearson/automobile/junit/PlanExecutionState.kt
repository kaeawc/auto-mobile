package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.DaemonToolResultParser.ParsedToolResult
import dev.jasonpearson.automobile.validation.ToolResultEntry

internal data class PlanExecutionRequest(
  val planContent: String,
  val options: AutoMobilePlanExecutionOptions,
  val startStep: Int,
  val recoveryAlreadyAttempted: Boolean,
  val secretValues: List<String>,
  val deviceIdOverride: String? = null,
  val sessionUuidOverride: String? = null,
)

internal data class PlanAttemptOutcome(
  val response: DaemonResponse,
  val outputPayload: String,
  val parsed: ParsedToolResult,
  val toolResults: List<ToolResultEntry>,
  val attemptSessionUuid: String,
)

internal data class PlanFailure(
  val result: CommandResult,
  val toolResults: List<ToolResultEntry>,
  val failedStepContext: FailedStepContext?,
  val heldSessionUuid: String?,
)
