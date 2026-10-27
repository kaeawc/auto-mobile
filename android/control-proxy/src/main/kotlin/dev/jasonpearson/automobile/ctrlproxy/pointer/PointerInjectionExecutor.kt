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
        return failed("injection was cancelled", events, injected, start, request.hover)
      }
      if (!sink.inject(event, start)) {
        return failed(
          "the system refused ${event.action} at ${event.atMs} ms",
          events,
          injected,
          start,
          request.hover,
        )
      }
      injected++
    }
    return PointerInjectionResult(true, injected = injected, elapsedMs = clock.nowMs() - start)
  }

  private fun failed(
    reason: String,
    events: List<PlannedPointerEvent>,
    injected: Int,
    start: Long,
    hover: Boolean,
  ): PointerInjectionResult {
    val opened = injected > 0
    val closer = if (hover) PointerAction.HOVER_EXIT else PointerAction.CANCEL
    var note = ""
    if (opened) {
      val last = events[injected - 1]
      val closed = sink.inject(last.copy(action = closer), start)
      if (!closed) note = "; the pointer could not be closed, so it may still be down or hovering"
    }
    return PointerInjectionResult(
      success = false,
      error = reason + note,
      injected = injected,
      elapsedMs = clock.nowMs() - start,
    )
  }
}
