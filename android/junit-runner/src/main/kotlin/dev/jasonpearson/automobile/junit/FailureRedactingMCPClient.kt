package dev.jasonpearson.automobile.junit

/**
 * Wraps the RAW (unredacted) [AutoMobileAgent.MCPClient] handed to [AutoMobileAgent.WaitForTool]
 * during AI-assisted recovery so a tool-call FAILURE cannot leak on-screen secret data (issue #6145
 * follow-up).
 *
 * [AutoMobileAgent.WaitForTool] is deliberately wired to the raw client rather than
 * [RedactingMCPClient] so its local "did the element appear" text search runs against the real
 * observe result — searching a redacted copy would falsely time out whenever the wait target is a
 * substring of an on-screen secret value (see [AutoMobileAgent.WaitForTool]'s class doc). That is
 * safe for a SUCCESSFUL call because [AutoMobileAgent.WaitForTool] never forwards the observe text
 * itself to the model — only a synthesized "found"/"timeout" string does.
 *
 * A FAILED call is a different channel: [DefaultMCPClient.callTool] throws with the MCP server's
 * response body / error in the exception message, which can echo on-screen data (a validation error
 * quoting the request, a server error including partial state). [AutoMobileAgent.WaitForTool] logs
 * that message (`println("Warning: waitFor observe failed, will retry: ${e.message}")`) on every
 * failed poll attempt, so an unredacted exception message leaks to the recovery log even though the
 * happy-path text search never leaks anything. Wrapping the raw client here keeps the happy path
 * exactly as before (the delegate's successful result is returned UNCHANGED, byte for byte, so the
 * local match still works) while scrubbing anything that escapes via a thrown exception, mirroring
 * [RedactingMCPClient]'s failure-path handling. The cause is dropped so the raw text cannot survive
 * in the exception chain.
 *
 * `internal` — its only consumer is [AutoMobileAgent.attemptAiRecovery]; unit-tested via
 * `WaitForToolRedactionTest`.
 */
internal class FailureRedactingMCPClient(
  private val delegate: AutoMobileAgent.MCPClient,
  private val secretValues: List<String>,
) : AutoMobileAgent.MCPClient {

  override fun isConnected(): Boolean = delegate.isConnected()

  override fun connect(serverUrl: String) = delegate.connect(serverUrl)

  override fun disconnect() = delegate.disconnect()

  override fun callTool(toolName: String, parameters: Map<String, Any>): String =
    try {
      delegate.callTool(toolName, parameters)
    } catch (e: Exception) {
      throw RuntimeException(SecretRedactor.redact(e.message ?: e.toString(), secretValues))
    }

  override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> =
    delegate.listAvailableTools()
}
