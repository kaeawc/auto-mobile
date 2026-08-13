package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.DeviceDragDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceDragRejection
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * The pure client-side drag-to-swipe policy (issue #3350). Pins the threshold from BOTH directions
 * — a rule that only rejects, or only accepts, would pass a one-sided test while being useless.
 */
class DeviceDragGesturePolicyTest {

  private val width = 1080
  private val height = 2340

  private fun at(x: Int, y: Int) =
    DevicePoint(x, y, inBounds = x in 0 until width && y in 0 until height)

  private fun evaluate(start: DevicePoint, end: DevicePoint) =
    DeviceDragGesturePolicy.evaluate(start, end, width, height)

  @Test
  fun `a drag past the threshold becomes one swipe with both mapped endpoints`() {
    val decision = evaluate(at(100, 200), at(100, 900))

    val swipe = assertIs<DeviceDragDecision.Swipe>(decision)
    assertEquals(100, swipe.start.x)
    assertEquals(200, swipe.start.y)
    assertEquals(100, swipe.end.x)
    assertEquals(900, swipe.end.y)
    assertEquals(DeviceDragGesturePolicy.SWIPE_DURATION_MS, swipe.durationMs)
  }

  @Test
  fun `a measured flick duration becomes the swipe duration (fling velocity)`() {
    val swipe =
      assertIs<DeviceDragDecision.Swipe>(
        DeviceDragGesturePolicy.evaluate(
          at(100, 200),
          at(100, 1400),
          width,
          height,
          gestureDurationMs = 80,
        )
      )
    // A fast flick (80ms over a long distance) replays as a short, high-velocity swipe → strong
    // fling, not the fixed fallback.
    assertEquals(80, swipe.durationMs)
  }

  @Test
  fun `a flick faster than the floor is clamped up, a drag slower than the ceiling clamped down`() {
    fun durationFor(gesture: Int) =
      assertIs<DeviceDragDecision.Swipe>(
          DeviceDragGesturePolicy.evaluate(
            at(100, 200),
            at(100, 1400),
            width,
            height,
            gestureDurationMs = gesture,
          )
        )
        .durationMs

    assertEquals(DeviceDragGesturePolicy.MIN_SWIPE_DURATION_MS, durationFor(1))
    assertEquals(DeviceDragGesturePolicy.MAX_SWIPE_DURATION_MS, durationFor(100_000))
  }

  @Test
  fun `a drag shorter than the threshold sends nothing`() {
    val decision =
      evaluate(at(100, 200), at(100, 200 + DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE - 1))

    assertEquals(
      DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold),
      decision,
      "one pixel below the threshold must not swipe",
    )
  }

  @Test
  fun `the threshold boundary is inclusive`() {
    // The other direction of the same rule: exactly at the threshold IS a swipe. Without this, a
    // policy that rejected everything would still satisfy the below-threshold test.
    val decision = evaluate(at(100, 200), at(100, 200 + DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE))

    assertIs<DeviceDragDecision.Swipe>(decision)
  }

  @Test
  fun `distance is straight-line, not per-axis`() {
    // A diagonal drag whose x and y components are each below the threshold but whose travelled
    // distance is above it. A per-axis check would wrongly reject this.
    val delta = DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE - 4
    val decision = evaluate(at(100, 200), at(100 + delta, 200 + delta))

    assertIs<DeviceDragDecision.Swipe>(decision)
  }

  @Test
  fun `a drag that starts off-screen is dropped, never clamped`() {
    val start = DevicePoint(-40, 200, inBounds = false)
    val decision = evaluate(start, at(500, 900))

    assertEquals(DeviceDragDecision.Ignored(DeviceDragRejection.StartOutOfBounds), decision)
  }

  @Test
  fun `a drag that ends off-screen is clamped to the last addressable pixel`() {
    val decision = evaluate(at(500, 2000), DevicePoint(500, 5000, inBounds = false))

    val swipe = assertIs<DeviceDragDecision.Swipe>(decision)
    assertEquals(height - 1, swipe.end.y, "the end pins to the last addressable row")
    assertEquals(500, swipe.end.x)
    assertEquals(true, swipe.end.inBounds, "a forwarded endpoint is never out of bounds")
  }

  @Test
  fun `clamping the end can drop the drag below the threshold`() {
    // Clamping happens BEFORE the distance check, so a long drag that leaves the screen right at
    // the edge is measured by what would actually be sent, not by where the pointer went.
    val decision = evaluate(at(500, height - 4), DevicePoint(500, 9_000, inBounds = false))

    assertEquals(DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold), decision)
  }

  @Test
  fun `a screen with no addressable pixel sends nothing`() {
    val decision =
      DeviceDragGesturePolicy.evaluate(
        DevicePoint(0, 0, inBounds = false),
        DevicePoint(0, 500, inBounds = false),
        deviceWidth = 0,
        deviceHeight = 0,
      )

    assertEquals(DeviceDragDecision.Ignored(DeviceDragRejection.NoAddressableScreen), decision)
  }

  @Test
  fun `the canonical-pixel threshold is pinned from both sides`() {
    val nativeScale = 3.0
    val pxThreshold = (DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE * nativeScale).toInt()

    assertEquals(
      DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold),
      DeviceDragGesturePolicy.evaluate(
        at(100, 200),
        at(100, 200 + pxThreshold - 1),
        width,
        height,
        CoordinateSpace.Pixels,
        nativeScale,
      ),
      "one pixel below the bar sends nothing",
    )
    assertIs<DeviceDragDecision.Swipe>(
      DeviceDragGesturePolicy.evaluate(
        at(100, 200),
        at(100, 200 + pxThreshold),
        width,
        height,
        CoordinateSpace.Pixels,
        nativeScale,
      ),
      "exactly at the bar swipes",
    )
  }

  @Test
  fun `a drag that is a swipe in point space is not one on a canonical-pixel frame`() {
    // The regression canonical pixels introduced, stated as one comparison: the SAME 24-unit
    // movement. In the legacy point space that is 24 logical points — above both platforms' touch
    // slop. On a px frame it is 24 physical pixels, which the daemon divides by nativeScale before
    // dispatch: 8 logical points on a 3x device, BELOW the ~10-point iOS slop, so the device would
    // read it as a tap rather than a drag.
    val start = at(100, 200)
    val end = at(100, 200 + 24)

    assertIs<DeviceDragDecision.Swipe>(
      DeviceDragGesturePolicy.evaluate(start, end, width, height, coordinateSpace = null),
      "the legacy path keeps its 24-unit behavior exactly",
    )
    assertEquals(
      DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold),
      DeviceDragGesturePolicy.evaluate(start, end, width, height, CoordinateSpace.Pixels, 3.0),
    )
    // A movement scaled up for the pixel space is a swipe again.
    assertIs<DeviceDragDecision.Swipe>(
      DeviceDragGesturePolicy.evaluate(
        start,
        at(100, 200 + 72),
        width,
        height,
        CoordinateSpace.Pixels,
        3.0,
      )
    )
  }

  @Test
  fun `the canonical-pixel threshold scales exactly with the published native scale`() {
    val scale = 3.5
    val threshold = DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE * scale

    assertEquals(
      DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold),
      DeviceDragGesturePolicy.evaluate(
        at(100, 200),
        at(100, 200 + threshold.toInt() - 1),
        width,
        height,
        CoordinateSpace.Pixels,
        scale,
      ),
    )
    assertIs<DeviceDragDecision.Swipe>(
      DeviceDragGesturePolicy.evaluate(
        at(100, 200),
        at(100, 200 + threshold.toInt()),
        width,
        height,
        CoordinateSpace.Pixels,
        scale,
      )
    )

    // The legacy point space is unchanged.
    assertEquals(24, DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE)
    assertEquals(
      DeviceDragGesturePolicy.MIN_SWIPE_DISTANCE.toDouble(),
      DeviceDragGesturePolicy.minSwipeDistance(null),
    )
    assertEquals(threshold, DeviceDragGesturePolicy.minSwipeDistance(CoordinateSpace.Pixels, scale))
  }

  @Test
  fun `a canonical-pixel frame without a valid scale fails closed`() {
    val start = at(100, 200)
    val end = at(100, 1_000)

    for (invalidScale in listOf<Double?>(null, 0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY)) {
      assertEquals(
        DeviceDragDecision.Ignored(DeviceDragRejection.BelowThreshold),
        DeviceDragGesturePolicy.evaluate(
          start,
          end,
          width,
          height,
          CoordinateSpace.Pixels,
          invalidScale,
        ),
        "nativeScale=$invalidScale must not authorize a px swipe",
      )
    }
  }

  @Test
  fun `the client swipe duration is inside the daemon's accepted range`() {
    // input/swipe rejects a durationMs outside [1, 60000]; a policy constant outside it would make
    // every forwarded swipe fail at the daemon.
    val duration = DeviceDragGesturePolicy.SWIPE_DURATION_MS
    assertEquals(true, duration in 1..60_000, "duration $duration is outside [1, 60000]")
  }
}
