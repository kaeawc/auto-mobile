package dev.jasonpearson.automobile.desktop.domain

import kotlin.math.hypot

/** Why [DeviceDragGesturePolicy] refused to turn a drag into a daemon swipe. */
public enum class DeviceDragRejection {
  /** The drag did not travel far enough to be a deliberate swipe. */
  BelowThreshold,

  /** The drag started outside the device screen, so its start cannot be safely repaired. */
  StartOutOfBounds,

  /** The device screen has no addressable pixel. */
  NoAddressableScreen,
}

/** The outcome of [DeviceDragGesturePolicy.evaluate]. */
public sealed interface DeviceDragDecision {
  /**
   * Send exactly one `input/swipe` with these endpoints. Both are guaranteed in-bounds, and
   * [durationMs] is the client policy duration.
   */
  public data class Swipe(val start: DevicePoint, val end: DevicePoint, val durationMs: Int) :
    DeviceDragDecision

  /** Send nothing. [reason] is diagnostic only; no daemon request or error is produced. */
  public data class Ignored(val reason: DeviceDragRejection) : DeviceDragDecision
}

/**
 * The client-side drag-to-swipe policy for a mirrored device screen (issue #3350).
 *
 * The daemon faithfully executes the endpoints and duration it is handed. This pure policy keeps
 * clients aligned on which gestures are deliberate swipes:
 * 1. The start must be in bounds.
 * 2. The end is clamped to the last addressable pixel.
 * 3. The clamped distance must reach the frame-specific physical threshold.
 */
public object DeviceDragGesturePolicy {

  /**
   * Minimum straight-line distance in logical points before a drag becomes a swipe.
   *
   * This is the legacy point-space threshold and the base value for canonical pixels. The daemon
   * divides canonical pixel coordinates by the runner's native scale before iOS dispatch, so a
   * canonical-pixel frame must multiply this value by its published native scale to preserve the
   * same physical intent.
   */
  public const val MIN_SWIPE_DISTANCE: Int = 24

  /**
   * The threshold for a frame's declared coordinate space.
   *
   * Canonical pixels multiply [MIN_SWIPE_DISTANCE] by the capture-bound [nativeScale]. A missing or
   * invalid scale cannot establish a safe physical threshold, so it fails closed by requiring an
   * unreachable distance. Legacy frames remain in logical points.
   */
  public fun minSwipeDistance(
    coordinateSpace: CoordinateSpace?,
    nativeScale: Double? = null,
  ): Double =
    if (coordinateSpace == CoordinateSpace.Pixels) {
      nativeScale?.takeIf { it.isFinite() && it > 0.0 }?.let { MIN_SWIPE_DISTANCE * it }
        ?: Double.POSITIVE_INFINITY
    } else {
      MIN_SWIPE_DISTANCE.toDouble()
    }

  /**
   * The duration handed to `input/swipe`, in milliseconds, when the client did not measure the
   * gesture's speed. A neutral mid value; overridden whenever a real flick duration is available.
   */
  public const val SWIPE_DURATION_MS: Int = 300

  /**
   * Floor for a measured swipe duration. A flick faster than this is clamped up so the daemon still
   * injects enough motion events to register a velocity (and to stay inside its `[1, 60000]`
   * range), while keeping the swipe short enough to read as a strong fling.
   */
  public const val MIN_SWIPE_DURATION_MS: Int = 40

  /**
   * Ceiling for a measured swipe duration. Past this a gesture is a deliberate slow drag, not a
   * fling; capping keeps a very long drag from producing an unnaturally languid device swipe.
   */
  public const val MAX_SWIPE_DURATION_MS: Int = 1_000

  /**
   * Resolve the `input/swipe` duration from the host gesture.
   *
   * Fling strength on the device is governed by the swipe's velocity — roughly distance over
   * duration — so replaying the swipe over *the wall-clock time the user's flick actually took*
   * reproduces the user's intent: a fast flick becomes a short, high-velocity swipe (a strong
   * fling), a slow drag a gentle one. A missing measurement falls back to [SWIPE_DURATION_MS].
   */
  public fun swipeDurationMs(gestureDurationMs: Int?): Int =
    gestureDurationMs?.coerceIn(MIN_SWIPE_DURATION_MS, MAX_SWIPE_DURATION_MS) ?: SWIPE_DURATION_MS

  /**
   * Decide whether a drag should become a swipe.
   *
   * [coordinateSpace] and [nativeScale] must come from the snapshot used to map both endpoints.
   * Missing canonical-pixel scale metadata fails closed. [gestureDurationMs] is how long the host
   * pointer was down for this gesture; when supplied it sets the swipe's velocity (see
   * [swipeDurationMs]), otherwise a fixed [SWIPE_DURATION_MS] is used.
   */
  public fun evaluate(
    start: DevicePoint,
    end: DevicePoint,
    deviceWidth: Int,
    deviceHeight: Int,
    coordinateSpace: CoordinateSpace? = null,
    nativeScale: Double? = null,
    gestureDurationMs: Int? = null,
  ): DeviceDragDecision {
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      return DeviceDragDecision.Ignored(DeviceDragRejection.NoAddressableScreen)
    }
    if (!start.inBounds) {
      return DeviceDragDecision.Ignored(DeviceDragRejection.StartOutOfBounds)
    }
    val clampedEnd = if (end.inBounds) end else end.clampedTo(deviceWidth, deviceHeight)
    val distance = hypot((clampedEnd.x - start.x).toDouble(), (clampedEnd.y - start.y).toDouble())
    if (distance < minSwipeDistance(coordinateSpace, nativeScale)) {
      return DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold)
    }
    return DeviceDragDecision.Swipe(
      start = start,
      end = clampedEnd,
      durationMs = swipeDurationMs(gestureDurationMs),
    )
  }
}
