package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.TapOnResponse
import dev.jasonpearson.automobile.validation.ToolResponse
import dev.jasonpearson.automobile.validation.ToolResult
import dev.jasonpearson.automobile.validation.ToolResultEntry

/**
 * Minimum time the JUnit runner waits on the daemon for one `executePlan` (socket read + inner MCP
 * `callTool`). Lower values caused premature inner HTTP cancellation and `Operation cancelled` on
 * long UI plans.
 *
 * Keep in sync with `MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS` in `src/daemon/mcpRequestTimeout.ts`.
 */
const val MIN_EXECUTE_PLAN_TIMEOUT_MS: Long = 600_000L

/** Configuration options for AutoMobile plan execution. */
data class AutoMobilePlanExecutionOptions(
  val timeoutMs: Long = MIN_EXECUTE_PLAN_TIMEOUT_MS,
  val device: String = "auto",
  val aiAssistance: Boolean = true,
  val maxRetries: Int = 0,
  val debugMode: Boolean = System.getProperty("automobile.debug", "false").toBoolean(),
  /**
   * Parameter keys whose substituted values are sensitive (tokens, passwords, PII). Their values
   * are masked out of any context handed to AI-assisted recovery before it reaches the third-party
   * LLM provider (see [AutoMobilePlanExecutor.buildFailedStepContext]), while the base64
   * `executePlan` payload to the LOCAL daemon keeps the real values so the plan can run. A plan can
   * also declare sensitive keys via its top-level `secretParameters:` list; the two sets are
   * unioned. Mirrors iOS's `AutoMobilePlanExecutor.Configuration.secretParameterKeys`
   * (issue #6029).
   */
  val secretParameterKeys: Set<String> = emptySet(),
)

/**
 * Effective wait budget for a single `executePlan` daemon call (never below
 * [MIN_EXECUTE_PLAN_TIMEOUT_MS]).
 */
fun AutoMobilePlanExecutionOptions.effectiveExecutePlanTimeoutMs(): Long =
  maxOf(timeoutMs, MIN_EXECUTE_PLAN_TIMEOUT_MS)

/** Result of AutoMobile plan execution. */
data class AutoMobilePlanExecutionResult(
  val success: Boolean,
  val exitCode: Int,
  val output: String = "",
  val errorMessage: String = "",
  val executionTimeMs: Long = 0L,
  val aiRecoveryAttempted: Boolean = false,
  val aiRecoverySuccessful: Boolean = false,
  val parametersUsed: Map<String, Any> = emptyMap(),
  val toolResults: List<ToolResultEntry> = emptyList(),
) {
  /** Get tool result by step index. */
  fun getToolResult(stepIndex: Int): ToolResult? {
    return toolResults.getOrNull(stepIndex) as? ToolResult
  }

  /** Get tool result entry by step index. */
  fun getToolResultEntry(stepIndex: Int): ToolResultEntry? {
    return toolResults.getOrNull(stepIndex)
  }

  /** Get tool error result by step index. */
  fun getErrorToolResult(stepIndex: Int): ErrorToolResult? {
    return toolResults.getOrNull(stepIndex) as? ErrorToolResult
  }

  /** Get the selected element text from a random tapOn operation. */
  fun getSelection(stepIndex: Int): String? {
    val result = getToolResult(stepIndex) ?: return null
    val tapOnResponse = result.response as? TapOnResponse
    return tapOnResponse?.selectedElement?.text
  }

  /** Get a specific response field by step index and tool type. */
  inline fun <reified T : ToolResponse> getTypedResponse(stepIndex: Int): T? {
    return getToolResult(stepIndex)?.response as? T
  }
}
