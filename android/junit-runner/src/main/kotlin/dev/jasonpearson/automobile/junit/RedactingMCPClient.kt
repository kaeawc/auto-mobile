package dev.jasonpearson.automobile.junit

/**
 * A redacting decorator over an [AutoMobileAgent.MCPClient] used during AI-assisted recovery
 * (CWE-200, issue #6094 — the second-order channel deferred from #6029 / #6092).
 *
 * The Koog recovery agent runs `observe`/`tapOn`/etc. and feeds each tool's RESULT string back into
 * the next model request. A secret still visible on screen at recovery time (a token echoed into a
 * field, present in the view hierarchy from observe's `withViewHierarchy = true`) would otherwise
 * reach the third-party LLM provider through those results. Wrapping the client the agent's tools
 * call scrubs every result before the agent hands it to the model.
 *
 * Scope boundary (mirrors [SecretRedactor]'s contract): the tool still EXECUTES against the device
 * with the REAL values — [callTool]'s arguments are forwarded to [delegate] unchanged, so on-device
 * behavior is identical. Only the RETURNED text (what re-enters the model transcript) is redacted.
 * The daemon `executePlan` payload is built elsewhere from the real substituted plan and never
 * passes through here. When there are no secret values the executor uses the raw client directly,
 * so this wrapper is only constructed when there is something to redact.
 *
 * `internal` — its only consumer is [AutoMobileAgent.attemptAiRecovery]; unit-tested via
 * `AutoMobileAgentTest`. Mirrors iOS `TachikomaPlanRecoveryHandler`'s per-result
 * `SecretRedaction.redact` calls.
 */
internal class RedactingMCPClient(
  private val delegate: AutoMobileAgent.MCPClient,
  private val secretValues: List<String>,
) : AutoMobileAgent.MCPClient {

  override fun isConnected(): Boolean = delegate.isConnected()

  override fun connect(serverUrl: String) = delegate.connect(serverUrl)

  override fun disconnect() = delegate.disconnect()

  /**
   * Execute the tool on the device with the REAL arguments, then scrub the RESULT so a secret
   * surfaced on screen cannot reach the LLM through the recovery loop (issue #6094). A tool failure
   * is scrubbed too: [DefaultMCPClient] throws with the MCP server's response body / error in the
   * message, which can echo the on-screen secret, and Koog feeds tool errors back to the model. The
   * redacted message is rethrown WITHOUT the original cause so the raw text cannot survive in the
   * exception chain (mirrors iOS `executeTool`'s error scrub).
   */
  override fun callTool(toolName: String, parameters: Map<String, Any>): String =
    try {
      SecretRedactor.redact(delegate.callTool(toolName, parameters), secretValues)
    } catch (e: Exception) {
      throw RuntimeException(SecretRedactor.redact(e.message ?: e.toString(), secretValues))
    }

  override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> =
    delegate.listAvailableTools()
}
