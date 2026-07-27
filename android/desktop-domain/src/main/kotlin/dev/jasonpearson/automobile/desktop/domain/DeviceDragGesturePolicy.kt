package dev.jasonpearson.automobile.desktop.domain

import kotlin.math.hypot

/** Why [DeviceDragGesturePolicy] refused to turn a drag into a daemon swipe. */
public enum class DeviceDragRejection {
  /**
   * The drag did not travel far enough to be a deliberate swipe. See
   * [DeviceDragGesturePolicy.minSwipeDistance].
   */
  BelowThreshold,

  /**
   * The drag STARTED outside the device screen, so there is no device pixel it began on. Unlike an
   * out-of-bounds end, this cannot be repaired by clamping — clamping would invent a start the user
   * never touched.
   */
  StartOutOfBounds,

  /**
   * The device screen has no addressable pixel (a non-positive dimension), so neither endpoint can
   * be expressed. Only reachable from a degenerate snapshot.
   */
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

  /** Send nothing. [reason] is diagnostic only; no daemon request is made and no error is shown. */
  public data class Ignored(val reason: DeviceDragRejection) : DeviceDragDecision
}

/**
 * The **client-side** drag-to-swipe policy for a mirrored device screen (issue
 * [#3350](https://github.com/kaeawc/auto-mobile/issues/3350)).
 *
 * The daemon has no say in any of this: `input/swipe` faithfully executes whatever endpoints and
 * duration it is handed, so deciding *whether a pointer drag is a swipe at all* is entirely the
 * client's job. This object is that decision, expressed purely so any daemon client — desktop, IDE,
 * or third-party in another language — can converge on the same behavior instead of inventing one.
 * The rules are documented for porting in `docs/design-docs/mcp/daemon/screen-control-mapping.md`.
 *
 * Three rules, in the order they are applied:
 * 1. **The start must be on the device screen.** A drag that began outside the rendered frame never
 *    touched a device pixel; it is dropped rather than clamped, because clamping would invent a
 *    starting point the user did not touch.
 * 2. **The end is clamped, not dropped.** Dragging *past* an edge is the ordinary way to scroll to
 *    the end of a list, so an end that lands outside the screen is pinned to the last addressable
 *    pixel (`DevicePoint.clampedTo`, explicitly sanctioned by the mapping contract). The result is
 *    well-formed input, never an off-screen coordinate.
 * 3. **The travelled distance must reach the threshold for the frame's coordinate space.** Measured
 *    in DEVICE coordinates, after clamping, as a straight-line distance between the endpoints. The
 *    threshold is a physical distance, so its numeric value depends on the unit the frame declares
 *    — see [minSwipeDistance].
 *
 * Pure: no clock, no Compose, no daemon. `evaluate` is a total function of its arguments.
 */
public object DeviceDragGesturePolicy {

  /**
   * Minimum straight-line distance, in device coordinates, before a drag becomes a swipe.
   *
   * Measured in **device** coordinates rather than viewport pixels on purpose. Viewport distance
   * depends on the client's zoom, so the same hand movement would send a swipe at one zoom level
   * and nothing at another, and a zoomed-out client would turn a few pixels of pointer jitter into
   * a large device gesture. Device coordinates are the space the daemon acts in, so the threshold
   * means the same thing for every client.
   *
   * `24` is chosen to sit just above the platforms' own touch slop **in the legacy point space** —
   * Android's `ViewConfiguration` slop is 8dp, which is ~24px at the ~3x density of a 1080p-class
   * phone, and iOS's is ~10 logical points — so any swipe forwarded past this bar is one the device
   * itself will interpret as a drag rather than as a tap. Below it, the client sends **nothing at
   * all**: it does not promote the gesture to a tap, because actuating an input the user did not
   * ask for is worse than ignoring an ambiguous one, and the view's own tap detector already covers
   * a click that barely moved.
   *
   * This constant is the LEGACY (undeclared-space) value. Under canonical pixels the unit changed
   * out from under it, so a second value applies; see [MIN_SWIPE_DISTANCE_PX] and
   * [minSwipeDistance].
   */
  public const val MIN_SWIPE_DISTANCE: Int = 24

  /**
   * Minimum straight-line distance when the frame declares [CoordinateSpace.Pixels] (issue #4550).
   *
   * Canonical pixels changed the unit this threshold is measured in, and on iOS that silently
   * shrank it. The daemon divides an incoming pixel coordinate by the runner's `nativeScale` before
   * dispatch, so on a 3x device 24 physical pixels reaches the runner as **8 logical points** —
   * *below* the ~10-point iOS touch slop the legacy value was chosen to clear. Movements the device
   * then reads as a tap rather than a drag would be forwarded as swipes.
   *
   * `32` restores the intent for the worst case this client can encounter: at `nativeScale` 3 it is
   * 10.67 logical points, just above the ~10-point slop, and at 2x it is 16 points — comfortably
   * above. Android publishes pixels at `nativeScale` 1, so its bar moves from 8dp to ~10.7dp at a
   * 3x density: still small, still above its own 8dp slop, and erring toward *not* sending a
   * gesture the user did not intend.
   *
   * A single constant rather than `24 * nativeScale` because **the observation stream does not
   * publish `nativeScale`** — the daemon keeps it internal (issue #4548) and a `"px"` frame's
   * screenshot and bounds are equal by construction, so the scale cannot be recovered client-side
   * either. Scaling exactly would need the daemon to publish it, which is a wire addition. Tracked
   * as follow-up; until then this constant is the conservative stand-in, chosen to be correct at
   * the worst scale rather than optimal at every one.
   */
  public const val MIN_SWIPE_DISTANCE_PX: Int = 32

  /**
   * The threshold that applies to a frame in [coordinateSpace] — [MIN_SWIPE_DISTANCE_PX] for
   * canonical pixels, [MIN_SWIPE_DISTANCE] for a legacy frame that declared none.
   *
   * Exposed so a client rendering a distance hint, or a third-party port, reads the same rule the
   * decision uses instead of re-deriving it.
   */
  public fun minSwipeDistance(coordinateSpace: CoordinateSpace?): Int =
    if (coordinateSpace == CoordinateSpace.Pixels) MIN_SWIPE_DISTANCE_PX else MIN_SWIPE_DISTANCE

  /**
   * The duration handed to `input/swipe`, in milliseconds.
   *
   * A fixed client policy value, not a measurement of the pointer gesture. Reproducing pointer
   * velocity would make the same on-screen gesture behave differently depending on how fast the
   * user's hand happened to move over a remote mirror whose frame rate is unrelated to the device's
   * — and would make swipes untestable without a clock. `300` reads as a deliberate drag on both
   * platforms (fast enough not to be a long-press, slow enough not to be a fling) and is inside the
   * daemon's accepted `[1, 60000]` range.
   */
  public const val SWIPE_DURATION_MS: Int = 300

  /**
   * Decide what a drag from [start] to [end] on a `deviceWidth` x `deviceHeight` screen should
   * send.
   *
   * [start] and [end] must both have been mapped through the **same** [DeviceFrameSnapshot], and
   * [deviceWidth]/[deviceHeight] must be that snapshot's mapping bounds — a swipe mapped through
   * two different frames is exactly the mis-scaling the snapshot contract exists to prevent.
   *
   * [coordinateSpace] must be that same snapshot's declared space: it selects the threshold, which
   * is a physical distance expressed in whatever unit the frame uses (see [minSwipeDistance]).
   * Defaulting to null keeps a caller that has no declaration on the legacy value.
   */
  public fun evaluate(
    start: DevicePoint,
    end: DevicePoint,
    deviceWidth: Int,
    deviceHeight: Int,
    coordinateSpace: CoordinateSpace? = null,
  ): DeviceDragDecision {
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      return DeviceDragDecision.Ignored(DeviceDragRejection.NoAddressableScreen)
    }
    if (!start.inBounds) {
      return DeviceDragDecision.Ignored(DeviceDragRejection.StartOutOfBounds)
    }
    val clampedEnd = if (end.inBounds) end else end.clampedTo(deviceWidth, deviceHeight)
    val distance = hypot((clampedEnd.x - start.x).toDouble(), (clampedEnd.y - start.y).toDouble())
    if (distance < minSwipeDistance(coordinateSpace)) {
      return DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold)
    }
    return DeviceDragDecision.Swipe(
      start = start,
      end = clampedEnd,
      durationMs = SWIPE_DURATION_MS,
    )
  }
}
