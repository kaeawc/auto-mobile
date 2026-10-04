package dev.jasonpearson.automobile.ctrlproxy

/** Timer seam for pacing and timeouts; callbacks and cancellation run on the gesture thread. */
internal fun interface GestureDeadline {
  fun schedule(delayMs: Long, onTimeout: () -> Unit): () -> Unit
}

/**
 * Dispatch a fixed plan through the streaming stroke adapter. Unlike a live stream, a drag has a
 * deadline per segment and must attempt to lift its continued pointer before reporting failure.
 *
 * Continued strokes complete at their last emitted event, so a stationary press completes at once;
 * the pointer stays down between continued strokes while this session waits out their planned time.
 * The press is timed from its completion callback because DOWN is injected after the dispatch call.
 * A stationary non-initial continued stroke is reported cancelled by the framework, so it is
 * replaced by a wait.
 */
internal class DragStrokeSession<S>(
  private val plan: List<GestureSegment>,
  private val dispatcher: StrokeDispatcher<S>,
  private val deadline: GestureDeadline,
  private val displayId: Int?,
  private val logError: (Exception) -> Unit,
  private val onFinished: (Boolean, String?) -> Unit,
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
) {
  private var previous: S? = null
  private var liftFrom: Pair<S, GesturePoint>? = null
  private var generation = 0
  private var terminal = false
  private var cleaningUp = false
  private var cancelDeadline: (() -> Unit)? = null

  fun start() = dispatchSegment(0)

  private fun dispatchSegment(index: Int) {
    if (terminal || cleaningUp) return
    if (index == plan.size) {
      finish(true, null)
      return
    }
    val segment = plan[index]
    if (!segment.isInitial && onlyPutsPointerDown(segment)) {
      waitThenAdvance(segment.durationMs, index + 1)
      return
    }
    val precedingLift = liftFrom
    try {
      val stroke =
        if (segment.isInitial) dispatcher.initialStroke(segment)
        else dispatcher.continueStroke(requireNotNull(previous), segment)
      previous = stroke
      if (segment.willContinue) liftFrom = stroke to segment.to
      val dispatchedAtMs = nowMs()
      dispatch(
        stroke,
        segment.durationMs + CALLBACK_GRACE_MS,
        onComplete = {
          val remaining =
            if (onlyPutsPointerDown(segment)) segment.durationMs
            else segment.durationMs - (nowMs() - dispatchedAtMs)
          waitThenAdvance(remaining, index + 1)
        },
        onFailed = ::fail,
        onRejected = { error ->
          liftFrom = precedingLift
          fail(error)
        },
      )
    } catch (e: Exception) {
      logError(e)
      liftFrom = precedingLift
      fail(e.message ?: "Failed to build or dispatch drag stroke")
    }
  }

  private fun onlyPutsPointerDown(segment: GestureSegment): Boolean =
    segment.willContinue &&
      Math.round(segment.from.x) == Math.round(segment.to.x) &&
      Math.round(segment.from.y) == Math.round(segment.to.y)

  private fun waitThenAdvance(delayMs: Long, nextIndex: Int) {
    if (delayMs <= 0) {
      dispatchSegment(nextIndex)
      return
    }
    val token = ++generation
    cancelDeadline =
      deadline.schedule(delayMs) {
        if (claim(token)) dispatchSegment(nextIndex)
      }
  }

  private fun dispatch(
    stroke: S,
    timeoutMs: Long,
    onComplete: () -> Unit,
    onFailed: (String) -> Unit,
    onRejected: (String) -> Unit = onFailed,
  ) {
    val token = ++generation
    cancelDeadline =
      deadline.schedule(timeoutMs) {
        if (claim(token)) onFailed("Drag stroke timed out")
      }
    dispatcher.dispatchContinuing(
      stroke,
      onComplete = { if (claim(token)) onComplete() },
      onFailed = { error -> if (claim(token)) onFailed(error) },
      onRejected = { error -> if (claim(token)) onRejected(error) },
      displayId = displayId,
    )
  }

  private fun claim(token: Int): Boolean {
    if (terminal || token != generation) return false
    generation++
    cancelDeadline?.invoke()
    cancelDeadline = null
    return true
  }

  private fun fail(error: String) {
    if (terminal || cleaningUp) return
    cleaningUp = true
    generation++
    cancelDeadline?.invoke()
    cancelDeadline = null
    val anchor = liftFrom
    if (anchor == null) {
      finish(false, error)
      return
    }
    try {
      // continueStroke must begin at its predecessor's endpoint, even after cancellation. The
      // framework can reject this best-effort lift if it already cancelled the pointer itself.
      val release =
        dispatcher.continueStroke(
          anchor.first,
          GestureSegment(anchor.second, anchor.second, 1L, false, false, true),
        )
      dispatch(
        release,
        CALLBACK_GRACE_MS,
        onComplete = { finish(false, error) },
        onFailed = { cleanupError ->
          finish(false, "$error; pointer release failed: $cleanupError")
        },
      )
    } catch (e: Exception) {
      logError(e)
      finish(false, "$error; pointer release failed: ${e.message ?: "dispatch exception"}")
    }
  }

  private fun finish(success: Boolean, error: String?) {
    if (terminal) return
    terminal = true
    generation++
    cancelDeadline?.invoke()
    cancelDeadline = null
    onFinished(success, error)
  }

  companion object {
    // One missed callback plus a bounded lift still fits the client's 600ms timeout allowance.
    private const val CALLBACK_GRACE_MS = 250L
  }
}
