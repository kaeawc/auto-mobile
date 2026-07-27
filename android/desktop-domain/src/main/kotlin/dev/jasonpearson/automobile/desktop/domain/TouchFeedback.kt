package dev.jasonpearson.automobile.desktop.domain

/**
 * A transient marker for a control-mode input the client actually forwarded, used to draw a brief
 * touch pulse where a tap landed (issue
 * [#3352](https://github.com/kaeawc/auto-mobile/issues/3352)).
 *
 * Pure model: device coordinates (the same space as hierarchy `bounds` and [DevicePoint]) plus the
 * client-clock instant the input was forwarded. A UI layer maps [x]/[y] back to viewport pixels
 * through the same geometry the tap was mapped with, and fades the pulse out over
 * [TouchFeedbackModel.DURATION_MS].
 *
 * The marker is recorded only for an input that reached the daemon dispatch queue — never for a
 * dropped one (an off-screen point, or a keystroke the policy declined) — so the pulse is honest
 * feedback rather than noise. Deciding that is the caller's job; this type only carries a point.
 */
public data class TouchFeedbackMarker(val x: Int, val y: Int, val startedAtMs: Long)

/**
 * A [TouchFeedbackMarker] still visible at a given instant, with its fade resolved.
 *
 * [progress] runs from `0.0` at the instant the input was forwarded to `1.0` at the moment the
 * pulse fully expires, so a UI layer derives alpha (`1 - progress`) and an expanding radius from it
 * without repeating the clock math.
 */
public data class ActiveTouchFeedback(val marker: TouchFeedbackMarker, val progress: Float)

/**
 * Holds the transient touch-feedback pulses for a mirrored device screen and resolves which are
 * still visible at a given client-clock instant (issue
 * [#3352](https://github.com/kaeawc/auto-mobile/issues/3352)).
 *
 * Pure and clock-free: every method takes `nowMs`, so the fade transitions are unit-tested with a
 * fed clock and no timer, exactly like the other `desktop-domain` policies. The reads
 * ([active]/[hasActive]) never mutate, so a UI layer may call them during composition or draw; the
 * list only shrinks in [record] (which prunes fully-faded markers first) and [reset].
 *
 * Feedback is deliberately capped at [MAX_MARKERS]: rapid tapping cannot grow the list without
 * bound, and the oldest pulse is dropped first since it is closest to fading anyway.
 */
public class TouchFeedbackModel(private val durationMs: Long = DURATION_MS) {
  private val markers = ArrayDeque<TouchFeedbackMarker>()

  /**
   * Record a forwarded input at device coordinate ([x], [y]) as of [nowMs], starting a fresh pulse.
   * Fully-faded markers are pruned first, and the oldest live one is dropped if this would exceed
   * [MAX_MARKERS].
   */
  public fun record(x: Int, y: Int, nowMs: Long) {
    markers.removeAll { progress(it, nowMs) >= 1f }
    markers.addLast(TouchFeedbackMarker(x, y, nowMs))
    while (markers.size > MAX_MARKERS) {
      markers.removeFirst()
    }
  }

  /** The pulses still visible at [nowMs], each with its resolved [ActiveTouchFeedback.progress]. */
  public fun active(nowMs: Long): List<ActiveTouchFeedback> = markers.mapNotNull { marker ->
    val p = progress(marker, nowMs)
    if (p >= 1f) null else ActiveTouchFeedback(marker, p)
  }

  /**
   * Whether any pulse is still visible at [nowMs]; drives whether a UI layer needs to keep ticking.
   */
  public fun hasActive(nowMs: Long): Boolean = markers.any { progress(it, nowMs) < 1f }

  /** Drop every pulse. Called when control mode exits, so a stale pulse never lingers. */
  public fun reset() {
    markers.clear()
  }

  /**
   * Fade progress of [marker] at [nowMs]: `0.0` when just recorded, `1.0` once [durationMs] has
   * elapsed. A non-positive [durationMs] makes every marker immediately expired (feedback off), and
   * a backwards clock step clamps to `0.0` rather than going negative.
   */
  private fun progress(marker: TouchFeedbackMarker, nowMs: Long): Float {
    if (durationMs <= 0L) return 1f
    val elapsed = nowMs - marker.startedAtMs
    return (elapsed.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
  }

  public companion object {
    /** How long, in milliseconds, a touch pulse stays visible before fully fading. */
    public const val DURATION_MS: Long = 600L

    /** Upper bound on simultaneously-retained pulses; the oldest is dropped past this. */
    public const val MAX_MARKERS: Int = 8
  }
}
