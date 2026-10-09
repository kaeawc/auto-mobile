package dev.jasonpearson.automobile.junit

/**
 * Makes AI recovery's first device call wait, within a bound, for a device that is busy (#10979).
 *
 * Recovery's LLM think time can outlast the daemon's idle window (heartbeats do not extend it), so
 * the session that held the device through the failed attempt is idle-released and a parallel
 * runner can take the device in the gap. The first call then comes back `device_owned_by_other_
 * session` (or `device_cleanup_in_progress` while the daemon is still releasing it). This is the
 * same held-device wait [AutoMobilePlanExecutor] applies to `executePlan`: exponential sleeps within
 * [AutoMobilePlanExecutor.deviceOwnedWaitBudgetMs], cancellable (an interrupt ends the wait), never
 * an exception that skips the bound. Once any call succeeds the device is ours and calls pass
 * straight through.
 *
 * A `session_ownership_lost` answer means the daemon released the held session and will not reuse
 * its UUID for ordinary calls; it is reported as a clear failure rather than retried.
 */
internal class HeldDeviceWaitingMCPClient(
  private val delegate: AutoMobileAgent.MCPClient,
  private val backoffDelayMs: (waitsSoFar: Int, waitedMs: Long) -> Long? = { waits, waited ->
    AutoMobilePlanExecutor.deviceOwnedBackoffDelayMs(waits, waited)
  },
  private val sleeper: (Long) -> Unit = { AutoMobilePlanExecutor.deviceOwnedSleeper(it) },
) : AutoMobileAgent.MCPClient {
  @Volatile private var deviceConfirmed = false
  private var waits = 0
  private var waitedMs = 0L

  override fun isConnected(): Boolean = delegate.isConnected()

  override fun connect(serverUrl: String) = delegate.connect(serverUrl)

  override fun disconnect() = delegate.disconnect()

  override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> =
    delegate.listAvailableTools()

  @Synchronized
  override fun callTool(toolName: String, parameters: Map<String, Any>): String {
    if (deviceConfirmed) return delegate.callTool(toolName, parameters)
    while (true) {
      try {
        val result = delegate.callTool(toolName, parameters)
        deviceConfirmed = true
        return result
      } catch (error: RuntimeException) {
        val message = error.message.orEmpty()
        if (BUSY_CODES.none(message::contains)) {
          if (OWNERSHIP_LOST_CODE in message) {
            throw RuntimeException(
              "The device session held for AI recovery was released by the daemon's idle window " +
                "before recovery's first call ($message)",
              error,
            )
          }
          throw error
        }
        val delayMs = backoffDelayMs(waits, waitedMs) ?: throw error
        println(
          "Device is busy for AI recovery; waiting ${delayMs}ms before retrying " +
            "(wait ${waits + 1}): $message",
        )
        sleeper(delayMs)
        waits++
        waitedMs += delayMs
      }
    }
  }

  private companion object {
    const val OWNERSHIP_LOST_CODE = "session_ownership_lost"
    val BUSY_CODES =
      listOf(
        AutoMobilePlanExecutor.DEVICE_OWNED_BY_OTHER_SESSION_CODE,
        "device_cleanup_in_progress",
      )
  }
}
