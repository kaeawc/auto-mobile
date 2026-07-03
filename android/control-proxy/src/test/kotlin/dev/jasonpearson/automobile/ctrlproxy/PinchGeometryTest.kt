package dev.jasonpearson.automobile.ctrlproxy

import kotlin.math.cos
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the two-finger pinch geometry convention shared by the Android and iOS runners (see
 * issue #2911). `rotationDegrees` describes how far the finger axis rotates *during* the pinch: the
 * axis starts horizontal (angle 0) and ends rotated by `rotationDegrees`. This is a combined
 * pinch+rotate, not a pinch along a fixed rotated axis. Both platforms must keep this convention so
 * cross-platform results match; this test is the executable guard.
 *
 * Pure trig, no Android dependencies, so it runs as a fast pure-JVM test — no Robolectric.
 */
class PinchGeometryTest {

  private val delta = 1e-3f

  @Test
  fun `radii are half the requested distances`() {
    val p =
      computePinchPoints(
        centerX = 100.0,
        centerY = 200.0,
        distanceStart = 80.0,
        distanceEnd = 300.0,
        rotationDegrees = 0f,
      )
    // Start axis horizontal: finger 1 sits startRadius to the right of center, finger 2 to the
    // left.
    assertEquals(100f + 40f, p.startX1, delta)
    assertEquals(100f - 40f, p.startX2, delta)
    // End radius is half of distanceEnd.
    assertEquals(100f + 150f, p.endX1, delta)
    assertEquals(100f - 150f, p.endX2, delta)
  }

  @Test
  fun `start axis is always horizontal regardless of rotation`() {
    val p =
      computePinchPoints(
        centerX = 540.0,
        centerY = 960.0,
        distanceStart = 100.0,
        distanceEnd = 300.0,
        rotationDegrees = 45f,
      )
    // Start fingers stay on the horizontal axis (y == centerY) even when rotationDegrees is
    // non-zero.
    assertEquals(960f, p.startY1, delta)
    assertEquals(960f, p.startY2, delta)
    assertEquals(540f + 50f, p.startX1, delta)
    assertEquals(540f - 50f, p.startX2, delta)
  }

  @Test
  fun `end axis is rotated by rotationDegrees`() {
    val rotation = 45f
    val p =
      computePinchPoints(
        centerX = 540.0,
        centerY = 960.0,
        distanceStart = 100.0,
        distanceEnd = 300.0,
        rotationDegrees = rotation,
      )
    val endRadius = 150.0
    val theta = Math.toRadians(rotation.toDouble())
    // End fingers lie on the axis rotated by `rotationDegrees` from horizontal.
    assertEquals((540.0 + endRadius * cos(theta)).toFloat(), p.endX1, delta)
    assertEquals((960.0 + endRadius * sin(theta)).toFloat(), p.endY1, delta)
    assertEquals((540.0 - endRadius * cos(theta)).toFloat(), p.endX2, delta)
    assertEquals((960.0 - endRadius * sin(theta)).toFloat(), p.endY2, delta)
  }

  @Test
  fun `negative rotation rotates the end axis the opposite way`() {
    val rotation = -30f
    val p =
      computePinchPoints(
        centerX = 200.0,
        centerY = 400.0,
        distanceStart = 100.0,
        distanceEnd = 100.0,
        rotationDegrees = rotation,
      )
    val radius = 50.0
    val theta = Math.toRadians(rotation.toDouble())
    // Sign of rotationDegrees must flow through to the end axis — cross-platform parity relies on
    // it. A negative angle puts endY1 below center, mirroring the positive case.
    assertEquals((400.0 + radius * sin(theta)).toFloat(), p.endY1, delta)
    assertEquals((200.0 + radius * cos(theta)).toFloat(), p.endX1, delta)
    // Start axis stays horizontal regardless of the sign.
    assertEquals(400f, p.startY1, delta)
    assertEquals(400f, p.startY2, delta)
  }

  @Test
  fun `zero rotation keeps both fingers on the horizontal axis`() {
    val p =
      computePinchPoints(
        centerX = 0.0,
        centerY = 0.0,
        distanceStart = 200.0,
        distanceEnd = 200.0,
        rotationDegrees = 0f,
      )
    // No rotation: start and end axes coincide, both horizontal — the common pinch/zoom case.
    assertEquals(0f, p.startY1, delta)
    assertEquals(0f, p.endY1, delta)
    assertEquals(100f, p.endX1, delta)
    assertEquals(-100f, p.endX2, delta)
  }
}
