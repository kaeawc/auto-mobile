package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.GlobalActionResult

/** System global actions (back, home, recents, ...) and their correlated results. */
internal class GlobalActionController(
  private val host: Host,
  private val asyncActionRunner: AsyncActionRunner,
  private val timeProvider: TimeProvider,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) {
  /** The service members a global action needs. */
  interface Host {
    /** `AccessibilityService.performGlobalAction`: true when the action was dispatched. */
    fun performGlobalAction(actionId: Int): Boolean

    /** A global action can move focus, so the remembered insert caret no longer applies. */
    fun forgetRememberedInsert()

    suspend fun broadcast(result: GlobalActionResult)
  }

  /** Handle a request_global_action WebSocket message. */
  fun performGlobalActionRequest(requestId: String?, action: String) {
    host.forgetRememberedInsert()
    val startTime = timeProvider.currentTimeMillis()
    val success = executeGlobalAction(action)
    val totalTimeMs = timeProvider.currentTimeMillis() - startTime
    asyncActionRunner.launch(requestId, "request_global_action") {
      host.broadcast(
        GlobalActionResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          action = action,
          totalTimeMs = totalTimeMs,
          error =
            if (!success) {
              SystemGlobalActions.refusal(action, sdkInt) ?: "Global action failed: $action"
            } else {
              null
            },
        ),
      )
    }
  }

  /**
   * Execute a global action (back, home, recents, etc.) via the accessibility service. Returns true
   * if the action was dispatched successfully.
   */
  private fun executeGlobalAction(action: String): Boolean {
    val actionId = SystemGlobalActions.resolve(action, sdkInt) ?: return false
    return host.performGlobalAction(actionId)
  }
}
