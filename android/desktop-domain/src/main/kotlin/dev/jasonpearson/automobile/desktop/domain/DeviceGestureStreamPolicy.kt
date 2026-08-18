package dev.jasonpearson.automobile.desktop.domain

import kotlin.math.abs

/** One coalesced device-space sample in a streamed gesture. */
public data class DeviceGesturePoint(val x: Int, val y: Int)

/** What the client should do with a raw host drag sample (issue: streaming gesture input). */
public sealed interface GestureStreamStep {
  /** Send one `input/gestureMove` carrying this coalesced point. */
  public data class Emit(val point: DeviceGesturePoint) : GestureStreamStep

  /**
   * Send nothing for this sample. Its position is not lost: it is superseded by a later [Emit] or
   * by the exact final point the client always sends with `input/gestureEnd`.
   */
  public object Coalesce : GestureStreamStep
}

/**
 * The client-side throttle that turns a host pointer's raw drag samples (60+/sec) into the far
 * smaller stream of `input/gestureMove` frames actually put on the wire (issue: streaming gesture
 * input).
 *
 * Two independent gates, both necessary:
 * 1. **Cadence** — at most one move per [minIntervalMs]. A mouse can report samples faster than the
 *    device can consume continued strokes, and flooding the persistent gesture connection would
 *    build latency the user sees as the finger lagging the cursor. Coalescing to roughly the frame
 *    cadence keeps the on-device touch tracking the pointer without a growing backlog.
 * 2. **Movement** — skip a sample that did not move at least [minMoveDistancePx] from the last
 *    *emitted* point (Chebyshev distance, cheap and axis-fair). This kills sub-pixel jitter and
 *    exact-duplicate samples the toolkit sometimes repeats, so a stationary hold does not spend
 *    wire frames; the runner already holds the touch at the last point on its own.
 *
 * The very first sample of a gesture always emits regardless of both gates, so the device begins
 * tracking immediately rather than after the first interval.
 *
 * Pure and clock-injected: [offer] takes `nowMs`, so a `FakeTimer`-driven test drives cadence
 * deterministically with no real delay. One instance owns one gesture; call [reset] (or make a new
 * instance) before the next.
 */
public class DeviceGestureStreamCoalescer(
  private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
  private val minMoveDistancePx: Int = DEFAULT_MIN_MOVE_DISTANCE_PX,
) {
  private var lastEmittedAtMs: Long? = null
  private var lastEmittedPoint: DeviceGesturePoint? = null

  /**
   * Offer one raw host drag sample at [nowMs]. Returns [GestureStreamStep.Emit] when this sample
   * should be sent as a move, or [GestureStreamStep.Coalesce] when it should be dropped. On an
   * [GestureStreamStep.Emit] the sample becomes the new "last emitted" reference for both gates.
   */
  public fun offer(
    x: Int,
    y: Int,
    nowMs: Long,
  ): GestureStreamStep {
    val point = DeviceGesturePoint(x, y)
    val lastAt = lastEmittedAtMs
    val lastPoint = lastEmittedPoint
    // First sample of the gesture: emit immediately so tracking starts without a cadence delay.
    if (lastAt == null || lastPoint == null) return emit(point, nowMs)
    // Cadence gate: too soon since the last emitted move.
    if (nowMs - lastAt < minIntervalMs) return GestureStreamStep.Coalesce
    // Movement gate: not far enough from the last emitted point to be worth a frame.
    val moved = maxOf(abs(point.x - lastPoint.x), abs(point.y - lastPoint.y))
    if (moved < minMoveDistancePx) return GestureStreamStep.Coalesce
    return emit(point, nowMs)
  }

  /** Clear all state so this coalescer can drive a fresh gesture. */
  public fun reset() {
    lastEmittedAtMs = null
    lastEmittedPoint = null
  }

  private fun emit(point: DeviceGesturePoint, nowMs: Long): GestureStreamStep {
    lastEmittedAtMs = nowMs
    lastEmittedPoint = point
    return GestureStreamStep.Emit(point)
  }

  public companion object {
    /**
     * One move every ~16ms caps the wire at roughly 60 frames/sec — the frame cadence the device
     * mirror itself runs at, so a faster host sample rate cannot outrun what the user can see.
     */
    public const val DEFAULT_MIN_INTERVAL_MS: Long = 16

    /** Two device pixels is below a deliberate drag step but above toolkit sub-pixel jitter. */
    public const val DEFAULT_MIN_MOVE_DISTANCE_PX: Int = 2
  }
}
