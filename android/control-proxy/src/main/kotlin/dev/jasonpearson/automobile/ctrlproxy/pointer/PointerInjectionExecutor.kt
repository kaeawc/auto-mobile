package dev.jasonpearson.automobile.ctrlproxy.pointer

/** Delivers one planned event; false means the system refused it. */
internal fun interface PointerEventSink {
  fun inject(event: PlannedPointerEvent, downTimeMs: Long): Boolean
}

internal fun interface PointerSleeper {
  fun sleep(ms: Long)
}

internal fun interface PointerClock {
  fun nowMs(): Long
}

internal data class PointerInjectionResult(
  val success: Boolean,
  val error: String? = null,
  val injected: Int = 0,
  val elapsedMs: Long = 0,
)

/**
 * Plays a validated request into a [PointerEventSink] on schedule. If an event is refused or the
 * run is cancelled partway, the pointer is closed (a cancel for a stroke, an exit for a hover) so
 * the app never keeps a pointer down or a hover open.
 */
internal class PointerInjectionExecutor(
  private val sink: PointerEventSink,
  private val sleeper: PointerSleeper,
  private val clock: PointerClock,
  private val isCancelled: () -> Boolean = { false },
) {
  fun run(request: PointerInjectionRequest): PointerInjectionResult {
    PointerInjectionPlanner.validate(request)?.let {
      return PointerInjectionResult(false, it)
    }
    val events = PointerInjectionPlanner.plan(request)
    val start = clock.nowMs()
    var injected = 0
    for (event in events) {
      val wait = start + event.atMs - clock.nowMs()
      if (wait > 0) sleeper.sleep(wait)
      if (isCancelled()) {
        val closeAt = events.getOrNull(injected - 1)
        return failed("injection was cancelled", closeAt, start, injected, request.hover)
      }
      val problem = deliver(event, start)
      if (problem != null) {
        // A delivery that threw may have reached the dispatcher, so that pointer is closed too.
        val closeAt = if (problem.threw) event else events.getOrNull(injected - 1)
        return failed(problem.reason, closeAt, start, injected, request.hover)
      }
      injected++
    }
    return PointerInjectionResult(true, injected = injected, elapsedMs = clock.nowMs() - start)
  }

  private class DeliveryProblem(val reason: String, val threw: Boolean)

  /** Null when [event] was injected; otherwise why not. */
  private fun deliver(event: PlannedPointerEvent, start: Long): DeliveryProblem? =
    try {
      if (sink.inject(event, start)) null
      else DeliveryProblem("the system refused ${event.action} at ${event.atMs} ms", threw = false)
    } catch (@Suppress("TooGenericExceptionCaught") error: RuntimeException) {
      // UiAutomation documents no exception type (a lost connection throws IllegalStateException);
      // the run must still close its pointer, or virtual device -1 keeps it down (#16028).
      DeliveryProblem(
        "injecting ${event.action} at ${event.atMs} ms failed: ${error.message}",
        true,
      )
    }

  /** Reports a failed run, first closing the pointer at [closeAt] if one may be open. */
  private fun failed(
    reason: String,
    closeAt: PlannedPointerEvent?,
    start: Long,
    injected: Int,
    hover: Boolean,
  ): PointerInjectionResult {
    val closer = if (hover) PointerAction.HOVER_EXIT else PointerAction.CANCEL
    var note = ""
    if (closeAt != null && deliver(closeAt.copy(action = closer), start) != null) {
      note = "; the pointer could not be closed, so it may still be down or hovering"
    }
    return PointerInjectionResult(
      success = false,
      error = reason + note,
      injected = injected,
      elapsedMs = clock.nowMs() - start,
    )
  }
}
