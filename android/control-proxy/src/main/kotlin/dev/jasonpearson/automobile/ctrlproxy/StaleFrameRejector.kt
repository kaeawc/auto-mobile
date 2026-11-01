package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.GlobalActionResult
import kotlinx.coroutines.CoroutineScope

/** The inputs that carry a frame-context token, each answered by its own result envelope. */
internal enum class StaleFrameContextAction(val wireName: String) {
  TAP("tap"),
  SWIPE("swipe"),
  DRAG("drag"),
  SET_TEXT("set_text"),
  IME_ACTION("ime_action"),
  GLOBAL_ACTION("global_action"),
}

/**
 * Refuses an input that was mapped through a screen state the service has since observed change,
 * answering it with the failed result its action normally sends so the caller never waits for a
 * timeout.
 */
internal class StaleFrameRejector(
  private val isStale: (expected: String?) -> Boolean,
  private val host: Host,
  private val timeProvider: TimeProvider,
) {
  /** The result envelopes a rejected input is answered with. */
  interface Host {
    fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit)

    suspend fun broadcastTapCoordinatesResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
    )

    suspend fun broadcastSwipeResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
      gestureTimeMs: Long?,
    )

    suspend fun broadcastDragResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
      gestureTimeMs: Long?,
    )

    suspend fun broadcastSetTextResult(
      requestId: String?,
      success: Boolean,
      error: String?,
      totalTimeMs: Long,
    )

    suspend fun broadcastImeActionResult(outcome: ImeActionFrameResult)

    suspend fun broadcastGlobalActionResult(result: GlobalActionResult)
  }

  /** True when the input was refused; its failed result is then already on its way. */
  fun rejectStaleFrameContext(
    requestId: String?,
    expected: String?,
    action: StaleFrameContextAction,
  ): Boolean {
    if (!isStale(expected)) return false
    val error =
      "Stale frame context for input/${action.wireName}; observe a fresh frame before retrying"
    host.launchRequestScope(requestId) { broadcastStaleFrameRejection(requestId, action, error) }
    return true
  }

  /**
   * Broadcasts the correlated stale-frame rejection for [action].
   *
   * A future [StaleFrameContextAction] added without its own branch must never route through no
   * branch and leave the caller to hang until timeout (issue #4577). At this module's Kotlin
   * language version the compiler already enforces that: a non-exhaustive `when` over the enum is a
   * compile error in statement or expression form. This is written expression-bodied so the
   * guarantee also survives lowering the language version below the level where non-exhaustive
   * `when` *statements* became errors (they are only warnings pre-2.0). Do not add an `else ->`
   * branch — it would defeat the check by making a missing action compile.
   */
  private suspend fun broadcastStaleFrameRejection(
    requestId: String?,
    action: StaleFrameContextAction,
    error: String,
  ) =
    when (action) {
      StaleFrameContextAction.TAP -> host.broadcastTapCoordinatesResult(requestId, false, error, 0)
      StaleFrameContextAction.SWIPE -> host.broadcastSwipeResult(requestId, false, error, 0, null)
      StaleFrameContextAction.DRAG -> host.broadcastDragResult(requestId, false, error, 0, null)
      StaleFrameContextAction.SET_TEXT -> host.broadcastSetTextResult(requestId, false, error, 0)
      StaleFrameContextAction.IME_ACTION ->
        host.broadcastImeActionResult(
          ImeActionFrameResult(
            requestId = requestId,
            action = action.wireName,
            success = false,
            error = error,
            totalTimeMs = 0,
          ),
        )
      StaleFrameContextAction.GLOBAL_ACTION ->
        host.broadcastGlobalActionResult(
          GlobalActionResult(
            timestamp = timeProvider.currentTimeMillis(),
            requestId = requestId,
            success = false,
            action = action.wireName,
            totalTimeMs = 0,
            error = error,
          ),
        )
    }
}
