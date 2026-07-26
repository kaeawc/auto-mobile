package dev.jasonpearson.automobile.desktop.core.control

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
  fun `the client swipe duration is inside the daemon's accepted range`() {
    // input/swipe rejects a durationMs outside [1, 60000]; a policy constant outside it would make
    // every forwarded swipe fail at the daemon.
    val duration = DeviceDragGesturePolicy.SWIPE_DURATION_MS
    assertEquals(true, duration in 1..60_000, "duration $duration is outside [1, 60000]")
  }
}
