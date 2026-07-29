package dev.jasonpearson.automobile.desktop.domain

import kotlin.math.abs

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

/**
 * A [TouchFeedbackMarker] still visible at a given instant, with its fade resolved.
 *
 * [progress] runs from `0.0` at the instant the input was forwarded to `1.0` at the moment the
 * pulse fully expires, so a UI layer derives alpha (`1 - progress`) and an expanding radius from it
 * without repeating the clock math.
 *
 * Placement is NOT resolved here: a renderer maps [marker]'s device point back to frame pixels by
 * building a [DeviceScreenGeometry] from the marker's own captured bounds and calling the canonical
 * [DeviceScreenCoordinateMapper.deviceToViewport] — one inverse transform for the whole module, so
 * a mapper fix can never leave pulse placement behind (issue #4546).
 */
public data class ActiveTouchFeedback(val marker: TouchFeedbackMarker, val progress: Float)

/**
 * Holds the transient touch-feedback pulses for a mirrored device screen and resolves which are
 * still visible right now (issue #3352).
 *
 * The clock is **injected and must be monotonic** ([nowMs]) — production passes
 * `System.nanoTime()`-based millis, the same source #3348 introduced for frame-age aging. Both the
 * record timestamp and the aging read come from this one clock, so a wall-clock step backward (NTP
 * correction, manual change, a VM/laptop resume) can neither strand a pulse visible nor spin the
 * host's recompose loop: monotonic time never regresses, so elapsed only grows and a pulse always
 * reaches expiry. Injecting it also keeps the fade transitions unit-testable with a fed clock and
 * no timer, exactly like the other `desktop-domain` policies.
 *
 * The reads ([active]/[hasActive]) never mutate, so a UI layer may call them during composition or
 * draw; the list only shrinks in [record] (which prunes fully-faded markers first) and [reset].
 *
 * Feedback is deliberately capped at [MAX_MARKERS]: rapid tapping cannot grow the list without
 * bound, and the oldest pulse is dropped first since it is closest to fading anyway.
 */
public class TouchFeedbackModel(
  private val durationMs: Long = DURATION_MS,
  private val nowMs: () -> Long = MONOTONIC_NOW_MS,
) {
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
  ) {
    if (forwarded) record(x, y, deviceWidth, deviceHeight)
  }

  /**
   * Record a forwarded input at device coordinate ([x], [y]) — mapped through a snapshot whose
   * bounds are [deviceWidth] x [deviceHeight] — stamped with the monotonic clock, starting a fresh
   * pulse. Fully-faded markers are pruned first, and the oldest live one is dropped if this would
   * exceed [MAX_MARKERS].
   */
  public fun record(x: Int, y: Int, deviceWidth: Int, deviceHeight: Int) {
    val now = nowMs()
    markers.removeAll { progress(it, now) >= 1f }
    markers.addLast(TouchFeedbackMarker(x, y, deviceWidth, deviceHeight, now))
    while (markers.size > MAX_MARKERS) {
      markers.removeFirst()
    }
  }

  /** The pulses still visible now, each with its resolved [ActiveTouchFeedback.progress]. */
  public fun active(): List<ActiveTouchFeedback> {
    val now = nowMs()
    return markers.mapNotNull { marker ->
      val p = progress(marker, now)
      if (p >= 1f) null else ActiveTouchFeedback(marker, p)
    }
  }

  /** Whether any pulse is still visible now; drives whether a UI layer keeps ticking. */
  public fun hasActive(): Boolean {
    val now = nowMs()
    return markers.any { progress(it, now) < 1f }
  }

  /** Drop every pulse. Called when control mode exits, so a stale pulse never lingers. */
  public fun reset() {
    markers.clear()
  }

  /**
   * Drop pulses whose captured aspect ratio no longer matches the current [deviceWidth] x
   * [deviceHeight] (issues #3352, #4546).
   *
   * A marker is placed by mapping its captured device point through its captured bounds (via
   * [DeviceScreenCoordinateMapper.deviceToViewport]), which is exact only while the frame keeps the
   * shape it was captured against. Two changes break that:
   * - a **rotation** (portrait↔landscape) flips the aspect, so the same device point maps into a
   *   differently-shaped frame and the pulse lands outside the clipped canvas;
   * - a **same-orientation aspect change** (1080x2340 -> 1080x1920) reshapes the frame the same way
   *   — a marker near the old bottom edge maps below the new frame.
   *
   * Both are caught by one rule: retain a marker only while its captured aspect matches the current
   * aspect within [GEOMETRY_ASPECT_TOLERANCE]. The two checks share a shape threshold, even though
   * this one is aspect-based for its own reason: both dimensions here come from frame snapshots and
   * are therefore always the same unit. An equal-aspect resolution change (1080x2340 -> 720x1560)
   * passes and keeps its pulses — that is exactly what the captured bounds already handle. A
   * transient 600ms marker is not worth transforming across a reshape, and a stale-shaped pulse is
   * worse than none — so it is simply dropped. Non-positive current dimensions describe no drawable
   * frame, so every pulse is dropped.
   */
  public fun retainOnlyMatchingAspect(deviceWidth: Int, deviceHeight: Int) {
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      markers.clear()
      return
    }
    val currentAspect = deviceHeight.toFloat() / deviceWidth.toFloat()
    markers.removeAll { marker ->
      marker.deviceWidth <= 0 ||
        marker.deviceHeight <= 0 ||
        abs(marker.deviceHeight.toFloat() / marker.deviceWidth.toFloat() - currentAspect) >
          GEOMETRY_ASPECT_TOLERANCE * currentAspect
    }
  }

  /**
   * Fade progress of [marker] at [now]: `0.0` when just recorded, `1.0` once [durationMs] has
   * elapsed. A non-positive [durationMs] makes every marker immediately expired (feedback off).
   * Elapsed is clamped at `0.0` defensively; a monotonic clock never produces a negative elapsed,
   * so this only guards a misconfigured (non-monotonic) injected clock.
   */
  private fun progress(marker: TouchFeedbackMarker, now: Long): Float {
    if (durationMs <= 0L) return 1f
    val elapsed = now - marker.startedAtMs
    return (elapsed.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
  }

  public companion object {
    /**
     * Default monotonic clock: `System.nanoTime()` in milliseconds. Mirrors desktop-core's
     * `MONOTONIC_NOW_MS` (#3348) so aging never rides the wall clock; unlike `currentTimeMillis()`
     * it cannot step backward.
     */
    public val MONOTONIC_NOW_MS: () -> Long = { System.nanoTime() / 1_000_000L }

    /** How long, in milliseconds, a touch pulse stays visible before fully fading. */
    public const val DURATION_MS: Long = 600L

    /** Upper bound on simultaneously-retained pulses; the oldest is dropped past this. */
    public const val MAX_MARKERS: Int = 8
  }
}
