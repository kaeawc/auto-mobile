package dev.jasonpearson.automobile.ctrlproxy

/**
 * Result produced by the shared AccessibilityService gesture dispatch lifecycle.
 *
 * [gestureTimeMs] is only present for completed gestures because cancellation, rejected dispatch,
 * and exceptions do not have a completed platform gesture duration.
 */
internal data class GestureDispatchOutcome(
  val completed: Boolean,
  val totalTimeMs: Long,
  val gestureTimeMs: Long?,
  val error: String?,
)

/**
 * Owns the perf bookkeeping that used to be hand-copied across each gesture callback.
 *
 * Android callback construction stays in [CtrlProxy], but every terminal branch routes through this
 * helper so the outer perf block is closed even when result handling throws.
 */
internal class GestureDispatchLifecycle(
  private val startTimeMs: Long,
  private val gestureBuiltTimeMs: Long,
  private val nowMs: () -> Long,
  private val startOperation: (String) -> Unit,
  private val endOperation: (String) -> Unit,
  private val endPerfBlock: () -> Unit,
) {
  fun startDispatch() {
    startOperation(DISPATCH_GESTURE_OPERATION)
  }

  fun completed(
    beforeResult: () -> Unit = {},
    onResult: (GestureDispatchOutcome) -> Unit,
  ) {
    val outcome: GestureDispatchOutcome
    try {
      endOperation(DISPATCH_GESTURE_OPERATION)
      beforeResult()
      val completedTime = nowMs()
      outcome =
        GestureDispatchOutcome(
          completed = true,
          totalTimeMs = completedTime - startTimeMs,
          gestureTimeMs = completedTime - gestureBuiltTimeMs,
          error = null,
        )
    } finally {
      endPerfBlock()
    }
    onResult(outcome)
  }

  fun cancelled(onResult: (GestureDispatchOutcome) -> Unit) {
    val cancelledTime = nowMs()
    finish(
      GestureDispatchOutcome(
        completed = false,
        totalTimeMs = cancelledTime - startTimeMs,
        gestureTimeMs = null,
        error = "Gesture was cancelled",
      ),
      onResult,
    )
  }

  fun notDispatched(onResult: (GestureDispatchOutcome) -> Unit) {
    val failedTime = nowMs()
    finish(
      GestureDispatchOutcome(
        completed = false,
        totalTimeMs = failedTime - startTimeMs,
        gestureTimeMs = null,
        error = "Failed to dispatch gesture",
      ),
      onResult,
    )
  }

  fun failed(error: Exception, onResult: (GestureDispatchOutcome) -> Unit) {
    val failedTime = nowMs()
    finish(
      GestureDispatchOutcome(
        completed = false,
        totalTimeMs = failedTime - startTimeMs,
        gestureTimeMs = null,
        error = error.message,
      ),
      onResult,
    )
  }

  private fun finish(
    outcome: GestureDispatchOutcome,
    onResult: (GestureDispatchOutcome) -> Unit,
  ) {
    try {
      endOperation(DISPATCH_GESTURE_OPERATION)
    } finally {
      endPerfBlock()
    }
    onResult(outcome)
  }

  companion object {
    private const val DISPATCH_GESTURE_OPERATION = "dispatchGesture"
  }
}
