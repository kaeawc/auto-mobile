package dev.jasonpearson.automobile.junit

/** Context about a failed test plan step, used to build a structured recovery prompt. */
data class FailedStepContext(
  val failedStepIndex: Int,
  val failedTool: String,
  val error: String,
  val succeededSteps: List<SucceededStepSummary>,
  val planContent: String,
  val deviceId: String?,
  /**
   * The `sessionUuid` of the failed `executePlan` attempt. Recovery tool calls and the resumed plan
   * reuse it so the device holder stays one session (#10783); null when unknown.
   */
  val sessionUuid: String? = null,
)

/** Summary of a step that completed successfully before the failure. */
data class SucceededStepSummary(val stepIndex: Int, val tool: String)

/** Outcome of an AI-assisted recovery attempt. */
data class RecoveryOutcome(
  val success: Boolean,
  val recoveryTimeMs: Long,
  val observeResultAfterRecovery: String? = null,
)
