package dev.jasonpearson.automobile.desktop.domain

/**
 * A transient marker for a control-mode input the client actually forwarded, used to draw a brief
 * touch pulse where a tap landed (issue #3352).
 *
 * The point is in device coordinates (the same space as hierarchy `bounds` and [DevicePoint]), and
 * [deviceWidth]/[deviceHeight] are the mapping bounds of the frame snapshot the tap was mapped
 * through — captured with the marker so the pulse renders back through the SAME geometry the tap
 * used. Binding the mapping bounds to the marker is what keeps the pulse from drifting if a
 * resolution or rotation change arrives during its fade, and what makes it land where the tap went
 * rather than where the live (possibly stale) hierarchy would put it.
 */
public data class TouchFeedbackMarker(
  val x: Int,
  val y: Int,
  val deviceWidth: Int,
  val deviceHeight: Int,
  val startedAtMs: Long,
)

/** Frame-pixel center of a pulse, produced by [ActiveTouchFeedback.frameOffset]. */
public data class TouchFeedbackFrameOffset(val x: Float, val y: Float)

/**
 * A [TouchFeedbackMarker] still visible at a given instant, with its fade resolved.
 *
 * [progress] runs from `0.0` at the instant the input was forwarded to `1.0` at the moment the
 * pulse fully expires, so a UI layer derives alpha (`1 - progress`) and an expanding radius from it
 * without repeating the clock math.
 */
public data class ActiveTouchFeedback(val marker: TouchFeedbackMarker, val progress: Float) {
  /**
   * The pulse's center in frame pixels, for a device frame [frameWidthPx] wide.
   *
   * Scaled through the marker's OWN captured [TouchFeedbackMarker.deviceWidth] — a single
   * width-based ratio for both axes, the exact inverse of the width-based viewport→device mapping —
   * so the pulse lands where the tap did and cannot drift when the live frame geometry changes
   * mid-fade. A non-positive captured width yields the origin (a degenerate snapshot has no
   * addressable pixel to place a pulse at).
   */
  public fun frameOffset(frameWidthPx: Float): TouchFeedbackFrameOffset {
    val scale = if (marker.deviceWidth > 0) frameWidthPx / marker.deviceWidth else 0f
    return TouchFeedbackFrameOffset(marker.x * scale, marker.y * scale)
  }
}

/**
 * Holds the transient touch-feedback pulses for a mirrored device screen and resolves which are
 * still visible at a given client-clock instant (issue #3352).
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
   * Record a pulse only when the input was actually [forwarded] to the device — i.e. the client's
   * dispatch accepted it. A tap that was dropped (off-screen, a full bounded queue) or never
   * dispatched (control unwired) must NOT pulse, or the indicator would claim a success that never
   * happened. This is the gate; [record] itself is unconditional.
   */
  public fun recordIfForwarded(
    forwarded: Boolean,
    x: Int,
    y: Int,
    deviceWidth: Int,
    deviceHeight: Int,
    nowMs: Long,
  ) {
    if (forwarded) record(x, y, deviceWidth, deviceHeight, nowMs)
  }

  /**
   * Record a forwarded input at device coordinate ([x], [y]) — mapped through a snapshot whose
   * bounds are [deviceWidth] x [deviceHeight] — as of [nowMs], starting a fresh pulse. Fully-faded
   * markers are pruned first, and the oldest live one is dropped if this would exceed
   * [MAX_MARKERS].
   */
  public fun record(x: Int, y: Int, deviceWidth: Int, deviceHeight: Int, nowMs: Long) {
    markers.removeAll { progress(it, nowMs) >= 1f }
    markers.addLast(TouchFeedbackMarker(x, y, deviceWidth, deviceHeight, nowMs))
    while (markers.size > MAX_MARKERS) {
      markers.removeFirst()
    }
  }

  /** The pulses still visible at [nowMs], each with its resolved [ActiveTouchFeedback.progress]. */
  public fun active(nowMs: Long): List<ActiveTouchFeedback> = markers.mapNotNull { marker ->
    val p = progress(marker, nowMs)
    if (p >= 1f) null else ActiveTouchFeedback(marker, p)
  }

  /** Whether any pulse is still visible at [nowMs]; drives whether a UI layer keeps ticking. */
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
