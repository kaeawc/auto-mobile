package dev.jasonpearson.automobile.junit

/**
 * Fails AI recovery's device calls fast once the daemon released the held session (#11072).
 *
 * The background heartbeat records a 404 answer with the daemon's `releaseReason`. From then on the
 * runner no longer holds the device, so every call through this client throws with that reason
 * instead of reaching a device another session may now drive. The exception carries no busy code,
 * so [HeldDeviceWaitingMCPClient] surfaces it without waiting.
 */
internal class SessionLossGuardMCPClient(
  private val delegate: AutoMobileAgent.MCPClient,
  private val sessionUuid: String,
  private val sessionLoss: (String) -> DaemonSessionLoss? = DaemonHeartbeat::sessionLoss,
) : AutoMobileAgent.MCPClient {
  override fun isConnected(): Boolean = delegate.isConnected()

  override fun connect(serverUrl: String) = delegate.connect(serverUrl)

  override fun disconnect() = delegate.disconnect()

  override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> =
    delegate.listAvailableTools()

  override fun callTool(toolName: String, parameters: Map<String, Any>): String {
    sessionLoss(sessionUuid)?.let { loss ->
      throw IllegalStateException("AI recovery stopped before $toolName: ${loss.describe()}")
    }
    return delegate.callTool(toolName, parameters)
  }
}
