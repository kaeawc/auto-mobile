package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.validation.ErrorToolResult
import dev.jasonpearson.automobile.validation.TapOnResponse
import dev.jasonpearson.automobile.validation.ToolResponse
import dev.jasonpearson.automobile.validation.ToolResult
import dev.jasonpearson.automobile.validation.ToolResultEntry

/** Configuration options for AutoMobile plan execution. */
data class AutoMobilePlanExecutionOptions(
    val timeoutMs: Long = 30000L, // 30 second default
    val device: String = "auto",
    val aiAssistance: Boolean = true,
    val maxRetries: Int = 0,
    val debugMode: Boolean = System.getProperty("automobile.debug", "false").toBoolean(),
    /**
     * When non-blank, the daemon runs post-execution cleanup after `executePlan` finishes (server
     * `toolRegistry` `finally`): either clear app data (if [cleanupClearAppData]) or force-stop only.
     *
     * Use this to avoid `launchApp` + `clearAppData` at the start of every plan so runtime permission
     * grants can survive across tests; clear or stop the app once after the plan instead.
     *
     * **Caveat:** cleanup runs after every `executePlan` invocation, including failed runs and each
     * JVM retry when [maxRetries] is greater than zero. Prefer `cleanupClearAppData = true` with
     * [maxRetries] = 0, or use terminate-only cleanup if you rely on retries.
     */
    val cleanupAppId: String? = null,
    /**
     * When true (with non-blank [cleanupAppId]), daemon clears app data after the plan; when false,
     * daemon only force-stops the app. Clearing wipes permissions and local state (same as `pm clear`).
     */
    val cleanupClearAppData: Boolean = false,
)

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
