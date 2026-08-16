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
  )
}

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
 * dispatch fails (failure). The owning registry uses it to drop the session.
 */
internal class GestureStreamSession<S>(
  private val coordinator: GestureStreamCoordinator,
  private val dispatcher: StrokeDispatcher<S>,
  private val runOnGestureThread: (() -> Unit) -> Unit,
  private val onFinished: (success: Boolean, error: String?) -> Unit,
) {
  private var previousStroke: S? = null
  private var terminal = false

  // The pump loop parks here when the coordinator returns Wait (touch held, no fresh move). A later
  // move/end resumes it. Without this, an idle drag would either dispatch a cancel-inducing hold or
  // stall forever.
  private var waiting = false

  /** Begin the gesture at ([x], [y]) and dispatch the initial press. Call once. */
  fun start(x: Float, y: Float) = runOnGestureThread { drive(coordinator.start(x, y)) }

  /** Feed a new move target. Safe to call from any thread; a no-op after the gesture finished. */
  fun move(x: Float, y: Float) = runOnGestureThread {
    coordinator.move(x, y)
    resumeIfWaiting()
  }

  /** Release (or [cancel]) the gesture. Safe to call from any thread. */
  fun end(x: Float, y: Float, cancel: Boolean) = runOnGestureThread {
    coordinator.end(x, y, cancel)
    resumeIfWaiting()
  }

  private fun pump() = drive(coordinator.next())

  /** Restart the parked pump loop after a move/end arrived while idle. */
  private fun resumeIfWaiting() {
    if (waiting && !terminal) {
      waiting = false
      pump()
    }
  }

  private fun drive(action: GestureStreamAction) {
    if (terminal) return
    when (action) {
      is GestureStreamAction.Done -> finish(success = true, error = null)
      is GestureStreamAction.Wait -> waiting = true
      is GestureStreamAction.Dispatch -> {
        val segment = action.segment
        val stroke =
          if (segment.isInitial) dispatcher.initialStroke(segment)
          else dispatcher.continueStroke(requireNotNull(previousStroke), segment)
        previousStroke = stroke
        // The dispatcher contract guarantees these callbacks fire on the gesture thread, so pump
        // the
        // next segment DIRECTLY — no re-post. The re-post added a full handler-queue cycle between
        // a
        // stroke completing and its continuation being dispatched, which on a busy thread was long
        // enough for the framework to cancel the continued gesture (issue: streaming gesture
        // input).
        dispatcher.dispatch(
          stroke = stroke,
          onComplete = { pump() },
          onFailed = { error -> finish(success = false, error = error) },
        )
      }
    }
  }

  private fun finish(success: Boolean, error: String?) {
    if (terminal) return
    terminal = true
    onFinished(success, error)
  }
}

/**
 * Tracks the in-flight streamed gestures by their wire `gestureId`, so [CtrlProxy]'s
 * `request_gesture_start`/`_move`/`_end` — each a separate request — reach the one session that
 * owns that gesture.
 *
 * All mutation happens on the gesture thread (sessions marshal their own work there and the finish
 * callback runs there), so a plain map guarded by the same single-thread discipline is sufficient;
 * the registry does not add its own locking.
 */
internal class GestureStreamRegistry {
  private val sessions = mutableMapOf<String, GestureStreamSession<*>>()

  /** True if a start for [gestureId] is already active — a duplicate start should be rejected. */
  fun contains(gestureId: String): Boolean = sessions.containsKey(gestureId)

  fun register(gestureId: String, session: GestureStreamSession<*>) {
    sessions[gestureId] = session
  }

  fun get(gestureId: String): GestureStreamSession<*>? = sessions[gestureId]

  fun remove(gestureId: String): GestureStreamSession<*>? = sessions.remove(gestureId)

  /** Snapshot of active gesture ids, for tearing every stream down when the service stops. */
  fun activeIds(): List<String> = sessions.keys.toList()
}
