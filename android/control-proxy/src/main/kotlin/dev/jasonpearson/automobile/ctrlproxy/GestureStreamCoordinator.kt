package dev.jasonpearson.automobile.ctrlproxy

/** A device-pixel point in a streamed gesture. */
internal data class GesturePoint(val x: Float, val y: Float)

/**
 * One continued-stroke segment the Android adapter should dispatch next.
 *
 * @property isInitial true only for the very first segment of a gesture — the adapter builds a
 *   fresh `StrokeDescription` for it; every later segment is a `continueStroke` on the previous
 *   one.
 * @property isHold true when [from] == [to]: a stationary segment that either presses at the start
 *   or keeps the touch alive while no fresh move has arrived. Distinguished from a move so the
 *   adapter and tests can assert holds do not spend the gesture on travel.
 * @property willContinue true while more strokes will follow; false on the final segment, which is
 *   what lifts the finger.
 */
internal data class GestureSegment(
  val from: GesturePoint,
  val to: GesturePoint,
  val durationMs: Long,
  val willContinue: Boolean,
  val isInitial: Boolean,
  val isHold: Boolean,
)

/** What the coordinator wants the Android adapter to do next. */
internal sealed interface GestureStreamAction {
  /** Dispatch [segment], then call [GestureStreamCoordinator.next] again when it completes. */
  data class Dispatch(val segment: GestureSegment) : GestureStreamAction

  /**
   * Nothing to dispatch right now — the drag is still down but no fresh move has arrived. Do NOT
   * dispatch anything: the last `willContinue` stroke already holds the finger down, and
   * dispatching a stationary keep-alive continuation is in fact what the framework CANCELS
   * (confirmed on device). The adapter parks here and calls [GestureStreamCoordinator.next] again
   * only when a [move] or [end] arrives.
   */
  data object Wait : GestureStreamAction

  /** The gesture is fully lifted (normal end or cancel). Nothing more to dispatch. */
  data object Done : GestureStreamAction
}

/**
 * The pure, Android-free state machine that turns a stream of gesture events (down, incremental
 * moves, up/cancel) into the sequence of `StrokeDescription`/`continueStroke` segments an
 * AccessibilityService dispatches — the on-device half of streaming gesture input.
 *
 * ### Why a machine and not one `dispatchGesture`
 * `GestureDescription.StrokeDescription.continueStroke` can only extend a `willContinue = true`
 * stroke, and the extension must be dispatched from the *previous* stroke's `onCompleted` callback.
 * So the cadence is gated by the platform gesture callback, not by the socket: the runner drives
 * its own continuation loop, draining moves that arrived over the wire since the last segment. This
 * machine owns exactly the decision — "given what has arrived, what is the next segment?" — with no
 * Android types, so the whole continuation policy is unit-tested without a device.
 *
 * ### Backpressure / coalescing at the runner
 * Moves are a bounded FIFO: if several arrive while one segment is in flight each is dispatched as
 * its own segment in order, so waypoint paths (dragPath, unlock patterns) are not collapsed
 * (#12994). The desktop client already thins host samples to roughly the frame cadence, so a live
 * drag rarely backs up; if it does beyond the cap the oldest points are dropped so the touch still
 * catches up to the cursor. When no fresh move is waiting and the gesture has not ended, the
 * machine returns [GestureStreamAction.Wait] and dispatches **nothing** — the last `willContinue`
 * stroke already holds the finger down. Dispatching a stationary keep-alive continuation there is
 * exactly what the framework CANCELS (confirmed on device), so the adapter parks until the next
 * [move]/[end].
 *
 * ### Termination
 * A normal [end] produces one final `willContinue = false` segment to the released point (that lift
 * is the up event). A cancelling [end] lifts in place immediately.
 *
 * Not thread-safe: the adapter must call [start]/[move]/[end]/[next] from a single thread (the
 * service's gesture-callback thread), which is how the AccessibilityService dispatch loop already
 * runs.
 */
internal class GestureStreamCoordinator(
  private val moveSegmentDurationMs: Long = DEFAULT_MOVE_SEGMENT_MS,
  private val pressDurationMs: Long = DEFAULT_PRESS_SEGMENT_MS,
  private val maxPendingMoves: Int = DEFAULT_MAX_PENDING_MOVES,
) {
  private var current: GesturePoint? = null
  private val pending = ArrayDeque<GesturePoint>()
  private var endPoint: GesturePoint? = null
  private var started = false
  private var ended = false
  private var cancelled = false
  private var finished = false

  /**
   * Begin the gesture at ([x], [y]). Returns the initial press segment (a stationary `willContinue
   * = true` stroke that puts the finger down). Must be called exactly once, before any other
   * method.
   */
  fun start(x: Float, y: Float): GestureStreamAction {
    check(!started) { "GestureStreamCoordinator.start called twice" }
    started = true
    val point = GesturePoint(x, y)
    current = point
    return GestureStreamAction.Dispatch(
      GestureSegment(
        from = point,
        to = point,
        durationMs = pressDurationMs,
        willContinue = true,
        isInitial = true,
        isHold = true,
      ),
    )
  }

  /**
   * Queue a move waypoint. Waypoints are FIFO so a precise path (an unlock pattern) is not
   * collapsed when several arrive within one in-flight segment (#12994); each becomes its own
   * continued stroke. The queue is bounded by [maxPendingMoves]: past it the oldest waypoint is
   * dropped, so a live drag that falls far behind still catches up instead of replaying seconds of
   * stale points. Ignored once the gesture has ended or been cancelled.
   */
  fun move(x: Float, y: Float) {
    if (ended || cancelled || finished) return
    if (pending.size >= maxPendingMoves) pending.removeFirst()
    pending.addLast(GesturePoint(x, y))
  }

  /**
   * Mark the gesture released at ([x], [y]). [cancel] lifts the touch in place on the next [next]
   * instead of travelling to ([x], [y]) — used when the pointer left the pane or focus was lost, so
   * a partial drag is abandoned rather than completed at a bogus endpoint.
   */
  fun end(x: Float, y: Float, cancel: Boolean = false) {
    if (finished) return
    ended = true
    cancelled = cancel
    endPoint = GesturePoint(x, y)
  }

  /** Lift in place during service teardown, without requiring a wire endpoint. */
  fun cancel() {
    if (finished) return
    cancelled = true
  }

  /**
   * Produce the next action after the previous segment completed. Returns
   * [GestureStreamAction.Done] once the finger has lifted; otherwise a
   * [GestureStreamAction.Dispatch] the adapter must send and then call [next] again on completion.
   */
  fun next(): GestureStreamAction {
    if (finished) return GestureStreamAction.Done
    val from = current ?: error("next() before start()")

    // Cancel wins over everything else: lift in place immediately.
    if (cancelled) return finish(from, from)

    // A fresh move is waiting: travel to it, staying down.
    pending.removeFirstOrNull()?.let { target ->
      current = target
      return GestureStreamAction.Dispatch(
        GestureSegment(
          from = from,
          to = target,
          durationMs = moveSegmentDurationMs,
          willContinue = true,
          isInitial = false,
          isHold = from == target,
        ),
      )
    }

    // No move waiting. If the user released, lift to the released point; otherwise wait — the last
    // willContinue stroke holds the finger down, and dispatching a stationary keep-alive here is
    // exactly what the framework cancels (confirmed on device), so we dispatch nothing and resume
    // when the next move/end arrives.
    if (ended) {
      val target = endPoint ?: from
      current = target
      return finish(from, target)
    }
    return GestureStreamAction.Wait
  }

  private fun finish(from: GesturePoint, to: GesturePoint): GestureStreamAction {
    finished = true
    return GestureStreamAction.Dispatch(
      GestureSegment(
        from = from,
        to = to,
        durationMs = moveSegmentDurationMs,
        willContinue = false,
        isInitial = false,
        isHold = from == to,
      ),
    )
  }

  companion object {
    /**
     * Short so the on-device touch stays close to the live cursor; long enough to register motion.
     */
    const val DEFAULT_MOVE_SEGMENT_MS: Long = 16

    /** The initial finger-down press. Brief; the touch is then held open by `willContinue`. */
    const val DEFAULT_PRESS_SEGMENT_MS: Long = 32

    /** Backlog cap: ~1 s of segments at [DEFAULT_MOVE_SEGMENT_MS]; far above any waypoint path. */
    const val DEFAULT_MAX_PENDING_MOVES: Int = 64
  }
}
