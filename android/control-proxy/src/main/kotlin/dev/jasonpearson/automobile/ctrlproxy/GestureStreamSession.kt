package dev.jasonpearson.automobile.ctrlproxy

/**
 * The Android touch-point for one streamed gesture, abstracted so the continuation loop
 * ([GestureStreamSession]) carries no framework types and is unit-testable.
 *
 * `S` is the platform stroke handle — on the device an
 * `android.accessibilityservice.GestureDescription.StrokeDescription`, in tests a fake — which
 * [continueStroke] needs so a later segment can extend the earlier `willContinue` stroke.
 */
internal interface StrokeDispatcher<S> {
  /** Build the first stroke of a gesture (a fresh `StrokeDescription`). */
  fun initialStroke(segment: GestureSegment): S

  /** Build a stroke that continues [previous] (a `StrokeDescription.continueStroke`). */
  fun continueStroke(previous: S, segment: GestureSegment): S

  /**
   * Dispatch [stroke]. Exactly one of [onComplete] / [onFailed] must be invoked when the platform
   * gesture callback fires — [onComplete] on completion (the signal to pump the next segment),
   * [onFailed] if the platform refused or cancelled the stroke.
   *
   * Both callbacks MUST run on the gesture thread (the same single thread [start]/[move]/[end] are
   * marshalled onto), so the session can chain the next segment with no extra thread hop. A
   * continued gesture is cancelled by the framework if the next stroke is not dispatched promptly
   * after the previous completes; re-posting the continuation across a thread hop (especially onto
   * a busy main thread) opens exactly that gap, so the contract is a same-thread callback.
   */
  fun dispatch(
    stroke: S,
    onComplete: () -> Unit,
    onFailed: (error: String) -> Unit,
    displayId: Int? = null,
  )

  /**
   * Distinguish a stroke rejected before injection from one cancelled after injection. A finite
   * chain must release the preceding pointer when a new continuation was never registered. Legacy
   * dispatchers can retain the original failure contract.
   */
  fun dispatchContinuing(
    stroke: S,
    onComplete: () -> Unit,
    onFailed: (error: String) -> Unit,
    onRejected: (error: String) -> Unit,
    displayId: Int? = null,
  ) = dispatch(stroke, onComplete, onFailed, displayId)
}

/** A stationary final continuation lifts the pointer; a stationary continuing stroke cancels. */
// Mirrors DragStrokeSession's pointer release; can be unified after the drag press change lands.
private fun pointerReleaseSegment(at: GesturePoint): GestureSegment =
  GestureSegment(at, at, 1L, false, false, true)

/**
 * Drives one streamed gesture: it turns the [GestureStreamCoordinator]'s segment decisions into
 * [StrokeDispatcher] calls, pumping the next segment each time the previous one completes, until
 * the coordinator reports the finger lifted.
 *
 * ### Threading
 * `StrokeDescription.continueStroke` requires the next stroke to be issued from the *previous*
 * stroke's completion callback, and the coordinator is single-threaded. So every mutation —
 * [start], [move], [end], and each pump — is funnelled onto one "gesture thread" via
 * [runOnGestureThread] (a dedicated `HandlerThread` in production, off the main thread so hierarchy
 * work cannot stall the continuation; a synchronous or manually-drained executor in tests). Callers
 * ([CtrlProxy]'s WebSocket handler) may therefore call [move]/[end] from any thread; the work is
 * marshalled, so the coordinator is never touched concurrently.
 *
 * [onFinished] fires exactly once, on the gesture thread, when the gesture lifts (success) or a
 * stroke fails, after any best-effort pointer release (failure). The owning router uses it to drop
 * the session.
 */
internal class GestureStreamSession<S>(
  private val coordinator: GestureStreamCoordinator,
  private val dispatcher: StrokeDispatcher<S>,
  private val runOnGestureThread: (() -> Unit) -> Unit,
  private val onFinished: (success: Boolean, error: String?) -> Unit,
) {
  private var previousStroke: S? = null
  private var liftFrom: Pair<S, GesturePoint>? = null
  private var terminal = false
  private var releasing = false
  private var cancelling = false
  private var lifting = false
  private var displayId: Int? = null

  // The pump loop parks here when the coordinator returns Wait (touch held, no fresh move). A later
  // move/end resumes it. Without this, an idle drag would either dispatch a cancel-inducing hold or
  // stall forever.
  private var waiting = false

  /** Begin the gesture at ([x], [y]) and dispatch the initial press. Call once. */
  fun start(x: Float, y: Float, displayId: Int? = null) = runOnGestureThread {
    if (terminal || releasing) return@runOnGestureThread
    this.displayId = displayId
    drive(coordinator.start(x, y))
  }

  /** Feed a new move target. Safe to call from any thread; a no-op after the gesture finished. */
  fun move(x: Float, y: Float) = runOnGestureThread {
    if (terminal || releasing) return@runOnGestureThread
    coordinator.move(x, y)
    resumeIfWaiting()
  }

  /** Release (or [cancel]) the gesture. Safe to call from any thread. */
  fun end(x: Float, y: Float, cancel: Boolean) = runOnGestureThread {
    if (terminal || releasing) return@runOnGestureThread
    coordinator.end(x, y, cancel)
    resumeIfWaiting()
  }

  /** Called by the router on the gesture thread for disconnect or service teardown. */
  fun cancel() {
    if (terminal || releasing || cancelling) return
    cancelling = true
    // A final stroke already releases the pointer. Keep its callback so failure is observable.
    if (lifting) return
    // The router can cancel before the posted start runs; there is no pointer to release yet.
    if (previousStroke == null) {
      finish(true, null)
      return
    }
    coordinator.cancel()
    waiting = false
    pump()
  }

  private fun pump() {
    if (terminal || releasing) return
    drive(coordinator.next())
  }

  /** Restart the parked pump loop after a move/end arrived while idle. */
  private fun resumeIfWaiting() {
    if (waiting && !terminal && !releasing) {
      waiting = false
      pump()
    }
  }

  private fun drive(action: GestureStreamAction) {
    if (terminal || releasing) return
    when (action) {
      is GestureStreamAction.Done -> finish(success = true, error = null)
      is GestureStreamAction.Wait -> waiting = true
      is GestureStreamAction.Dispatch -> {
        val segment = action.segment.clampedToNonNegative()
        if (!segment.willContinue) lifting = true
        if (
          !segment.isInitial &&
            segment.willContinue &&
            action.segment.from != action.segment.to &&
            segment.from == segment.to
        ) {
          pump()
          return
        }
        val precedingLift = liftFrom
        try {
          val stroke =
            if (segment.isInitial) dispatcher.initialStroke(segment)
            else dispatcher.continueStroke(requireNotNull(previousStroke), segment)
          previousStroke = stroke
          if (segment.willContinue) liftFrom = stroke to segment.to
          // The dispatcher contract guarantees these callbacks fire on the gesture thread, so pump
          // the
          // next segment DIRECTLY — no re-post. The re-post added a full handler-queue cycle
          // between
          // a
          // stroke completing and its continuation being dispatched, which on a busy thread was
          // long
          // enough for the framework to cancel the continued gesture (issue: streaming gesture
          // input).
          dispatcher.dispatchContinuing(
            stroke = stroke,
            displayId = displayId,
            onComplete = { if (previousStroke === stroke) pump() },
            onFailed = { error -> if (previousStroke === stroke) fail(error) },
            onRejected = { error ->
              if (!terminal && !releasing && previousStroke === stroke) {
                liftFrom = precedingLift
                fail(error)
              }
            },
          )
        } catch (e: Exception) {
          // No Android log call: this framework-free session has no injected logger for JVM tests.
          if (!terminal && !releasing) {
            liftFrom = precedingLift
            fail(e.message ?: "Failed to build streamed gesture stroke")
          }
        }
      }
    }
  }

  /**
   * Clamp both endpoints to non-negative coordinates consistently to preserve stroke continuity;
   * there is no upper-bound clamp. Moving continuations collapsed by clamping must be skipped:
   * Android cancels stationary continued strokes, but the previous stroke already holds this point.
   * Genuine holds, initial presses and final lifts still dispatch.
   */
  private fun GestureSegment.clampedToNonNegative(): GestureSegment =
    copy(
      from = from.copy(x = from.x.coerceAtLeast(0f), y = from.y.coerceAtLeast(0f)),
      to = to.copy(x = to.x.coerceAtLeast(0f), y = to.y.coerceAtLeast(0f)),
    )

  private fun fail(error: String) {
    if (terminal || releasing) return
    // Cancellation already attempted its lift. Report a rejected/failed lift without retrying it.
    if (cancelling) {
      finish(false, error)
      return
    }
    releasing = true
    waiting = false
    val anchor = liftFrom
    if (anchor == null) {
      finish(false, error)
      return
    }
    try {
      val release = dispatcher.continueStroke(anchor.first, pointerReleaseSegment(anchor.second))
      // No deadline seam exists here: wait for the release callback before reporting the failure.
      dispatcher.dispatchContinuing(
        stroke = release,
        displayId = displayId,
        onComplete = { finish(false, error) },
        onFailed = { finish(false, error) },
        onRejected = { finish(false, error) },
      )
    } catch (_: Exception) {
      finish(false, error)
    }
  }

  private fun finish(success: Boolean, error: String?) {
    if (terminal) return
    terminal = true
    onFinished(success, error)
  }
}
