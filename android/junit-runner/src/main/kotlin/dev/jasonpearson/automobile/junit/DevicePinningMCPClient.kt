package dev.jasonpearson.automobile.junit

/**
 * Pins every AI-recovery tool call to the device the failed plan step ran on (#10089).
 *
 * The recovery agent's tools call `observe`, `tapOn`, `swipeOn`, ... with no device routing, so
 * with two devices attached the daemon either rejects the call ("Multiple Android devices
 * detected") or acts on whichever device it defaults to — not the one the plan failed on. This
 * decorator adds the failed step's real `deviceId` (resolved by [AutoMobilePlanExecutor] from the
 * `executePlan` payload, never a plan device label) to each call, the same pin the resumed plan
 * uses.
 *
 * A call that already names its own target (`deviceId`, `sessionUuid` or a `device` label) is
 * forwarded unchanged. An `observe` with a `deviceId` and no session is the daemon's sessionless
 * device read, which rejects `raw`; a pinned `raw: true` observe is therefore sent as `project:
 * "full"`, the full filtered hierarchy the daemon's own error points to.
 */
internal class DevicePinningMCPClient(
  private val delegate: AutoMobileAgent.MCPClient,
  private val deviceId: String,
) : AutoMobileAgent.MCPClient {

  override fun isConnected(): Boolean = delegate.isConnected()

  override fun connect(serverUrl: String) = delegate.connect(serverUrl)

  override fun disconnect() = delegate.disconnect()

  override fun callTool(toolName: String, parameters: Map<String, Any>): String =
    delegate.callTool(toolName, pin(toolName, parameters))

  override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> =
    delegate.listAvailableTools()

  private fun pin(toolName: String, parameters: Map<String, Any>): Map<String, Any> {
    if (ROUTING_KEYS.any(parameters::containsKey)) return parameters
    val pinned = LinkedHashMap(parameters)
    if (toolName == "observe" && pinned.remove("raw") == true) {
      pinned.putIfAbsent("project", "full")
    }
    pinned["deviceId"] = deviceId
    return pinned
  }

  internal companion object {
    private val ROUTING_KEYS = listOf("deviceId", "sessionUuid", "device")

    /**
     * [delegate] pinned to [deviceId], or [delegate] itself (with a warning) when the failed step's
     * device is unknown, so recovery still runs on a single-device setup.
     */
    fun pinTo(delegate: AutoMobileAgent.MCPClient, deviceId: String?): AutoMobileAgent.MCPClient {
      val id = deviceId?.takeIf { it.isNotBlank() }
      if (id == null) {
        println(
          "Warning: the failed step's device id is unknown; AI recovery tool calls are not " +
            "pinned to a device and will fail if more than one device is attached"
        )
        return delegate
      }
      return DevicePinningMCPClient(delegate, id)
    }
  }
}
