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

  /**
   * SHARED GOLDEN TABLE — the single source of truth is `test/fixtures/pinch-golden-vectors.json`;
   * `test/parity/pinchGoldenVectorParity.test.ts` verifies this table and the iOS mirror
   * (`PinchGeometryTests.swift`'s `testGoldenVectorsMatchAndroidParity`) against it. Each row is an
   * input tuple and its expected *unordered* set of four endpoints. The comparison is
   * order-independent because the two runners label which finger is "first" oppositely (Android
   * builds center±offset, iOS center∓offset first) while producing the same two touch points. If
   * either platform's endpoint math changes, its golden assertion fails loudly here or in the Swift
   * mirror. If the two tables silently diverge — including a coordinated one-sided convention edit
   * (change math + golden on one platform only) — the parity guard fails. Edit the JSON and both
   * platform tables together. See issues #2911 / #2979 / #2997.
   */
  private data class Vector(
    val centerX: Double,
    val centerY: Double,
    val distanceStart: Double,
    val distanceEnd: Double,
    val rotationDegrees: Float,
    val expected: List<Pair<Float, Float>>,
  )

  private val vectors =
    listOf(
      Vector(
        100.0,
        200.0,
        80.0,
        300.0,
        0f,
        listOf(60f to 200f, 140f to 200f, -50f to 200f, 250f to 200f),
      ),
      Vector(
        540.0,
        960.0,
        100.0,
        300.0,
        45f,
        listOf(
          490f to 960f,
          590f to 960f,
          433.933983f to 853.933983f,
          646.066017f to 1066.066017f,
        ),
      ),
      Vector(
        200.0,
        400.0,
        100.0,
        100.0,
        -30f,
        listOf(150f to 400f, 250f to 400f, 156.698730f to 425f, 243.301270f to 375f),
      ),
      // A second asymmetric negative angle so drop-rotation-sign / sin-cos-swap detection is not
      // a single point of failure on the -30 row (the +45 / rot-0 rows are blind to a dropped
      // sign). distanceStart != distanceEnd also exercises unequal radii.
      Vector(
        300.0,
        500.0,
        200.0,
        80.0,
        -60f,
        listOf(200f to 500f, 400f to 500f, 280f to 534.641016f, 320f to 465.358984f),
      ),
      Vector(
        0.0,
        0.0,
        200.0,
        200.0,
        0f,
        listOf(-100f to 0f, 100f to 0f, -100f to 0f, 100f to 0f),
      ),
    )

  @Test
  fun `golden vectors match iOS parity`() {
    for (v in vectors) {
      val p =
        computePinchPoints(v.centerX, v.centerY, v.distanceStart, v.distanceEnd, v.rotationDegrees)
      val actual =
        sortedPoints(
          listOf(
            p.startX1 to p.startY1,
            p.startX2 to p.startY2,
            p.endX1 to p.endY1,
            p.endX2 to p.endY2,
          ),
        )
      val expected = sortedPoints(v.expected)
      actual.zip(expected).forEach { (a, e) ->
        assertEquals("x mismatch for $v", e.first, a.first, delta)
        assertEquals("y mismatch for $v", e.second, a.second, delta)
      }
    }
  }

  @Test
  fun `computePinchPoints does not clamp degenerate distances`() {
    // The pure function must NOT floor a zero distance: radius 0 collapses all four endpoints
    // onto the center. The iOS runner mirrors this — any minimum-distance floor is an
    // iOS-synthesis-wrapper concern, not part of the shared convention. See #2979.
    val p =
      computePinchPoints(
        centerX = 320.0,
        centerY = 480.0,
        distanceStart = 0.0,
        distanceEnd = 0.0,
        rotationDegrees = 45f,
      )
    listOf(
        p.startX1 to p.startY1,
        p.startX2 to p.startY2,
        p.endX1 to p.endY1,
        p.endX2 to p.endY2,
      )
      .forEach { (x, y) ->
        assertEquals(320f, x, delta)
        assertEquals(480f, y, delta)
      }
  }

  @Test
  fun `pure rotation keeps a constant radius along the whole path`() {
    // Regression for issue #12996: a straight chord between the start and end points shrinks the
    // radius to cos(rotation / 2) of the original mid-gesture, so a rotation-only pinch zoomed.
    val centerX = 200.0
    val centerY = 400.0
    val interior = computePinchPathInterior(centerX, centerY, 100.0, 100.0, 90f)
    assertEquals(pinchSegmentCount(90f) - 1, interior.size)
    interior.forEach { p ->
      assertEquals(50.0, Math.hypot(p.x1 - centerX, p.y1 - centerY), delta.toDouble())
      assertEquals(50.0, Math.hypot(p.x2 - centerX, p.y2 - centerY), delta.toDouble())
    }
  }

  @Test
  fun `rotating pinch interpolates the radius linearly with the angle`() {
    val interior = computePinchPathInterior(0.0, 0.0, 200.0, 80.0, -60f)
    interior.forEachIndexed { index, p ->
      val fraction = (index + 1).toDouble() / pinchSegmentCount(-60f)
      assertEquals(
        (200.0 + (80.0 - 200.0) * fraction) / 2.0,
        Math.hypot(p.x1.toDouble(), p.y1.toDouble()),
        delta.toDouble(),
      )
    }
  }

  @Test
  fun `non rotating pinch stays a single straight segment`() {
    assertEquals(1, pinchSegmentCount(0f))
    assertEquals(
      emptyList<PinchFingerPositions>(),
      computePinchPathInterior(0.0, 0.0, 80.0, 300.0, 0f),
    )
  }

  @Test
  fun `segment count follows rotation magnitude and is bounded`() {
    assertEquals(1, pinchSegmentCount(5f))
    assertEquals(9, pinchSegmentCount(90f))
    assertEquals(9, pinchSegmentCount(-90f))
    assertEquals(36, pinchSegmentCount(360f))
    assertEquals(35, pinchSegmentCount(350f))
    assertEquals(36, pinchSegmentCount(100000f))
    assertEquals(36, pinchSegmentCount(Float.MAX_VALUE))
    assertEquals(1, pinchSegmentCount(Float.POSITIVE_INFINITY))
    assertEquals(1, pinchSegmentCount(Float.NaN))
  }

  @Test
  fun `path fractions zero and one equal the endpoint geometry`() {
    val p = computePinchPoints(540.0, 960.0, 100.0, 300.0, 45f)
    val start =
      computePinchFingerPositions(
        PinchStrokeGeometry(540.0, 960.0, 100.0, 300.0, 45f),
        fraction = 0.0,
      )
    val end =
      computePinchFingerPositions(
        PinchStrokeGeometry(540.0, 960.0, 100.0, 300.0, 45f),
        fraction = 1.0,
      )
    assertEquals(p.startX1, start.x1, delta)
    assertEquals(p.startY1, start.y1, delta)
    assertEquals(p.startX2, start.x2, delta)
    assertEquals(p.startY2, start.y2, delta)
    assertEquals(p.endX1, end.x1, delta)
    assertEquals(p.endY1, end.y1, delta)
    assertEquals(p.endX2, end.x2, delta)
    assertEquals(p.endY2, end.y2, delta)
  }

  /**
   * SHARED PATH GOLDEN TABLE — the single source of truth is
   * `test/fixtures/pinch-path-golden-vectors.json`; `test/parity/pinchGoldenVectorParity.test.ts`
   * verifies this table and the iOS mirror (`testPathGoldenVectorsMatchAndroidParity`) against it.
   * Each row is (centerX, centerY, distanceStart, distanceEnd, rotationDegrees, fraction) followed
   * by the expected *unordered* pair of finger positions at that fraction of the gesture.
   */
  private data class PathVector(
    val centerX: Double,
    val centerY: Double,
    val distanceStart: Double,
    val distanceEnd: Double,
    val rotationDegrees: Float,
    val fraction: Double,
    val expected: List<Pair<Float, Float>>,
  )

  private val pathVectors =
    listOf(
      PathVector(
        200.0,
        400.0,
        100.0,
        100.0,
        90f,
        0.5,
        listOf(235.355339f to 435.355339f, 164.644661f to 364.644661f),
      ),
      PathVector(
        200.0,
        400.0,
        100.0,
        100.0,
        90f,
        0.25,
        listOf(246.193977f to 419.134172f, 153.806023f to 380.865828f),
      ),
      PathVector(
        300.0,
        500.0,
        200.0,
        80.0,
        -60f,
        0.5,
        listOf(360.621778f to 465f, 239.378222f to 535f),
      ),
      PathVector(0.0, 0.0, 200.0, 200.0, 0f, 0.5, listOf(100f to 0f, -100f to 0f)),
      PathVector(
        540.0,
        960.0,
        100.0,
        300.0,
        45f,
        1.0,
        listOf(646.066017f to 1066.066017f, 433.933983f to 853.933983f),
      ),
      PathVector(
        540.0,
        960.0,
        100.0,
        300.0,
        45f,
        0.5,
        listOf(632.387953f to 998.268343f, 447.612047f to 921.731657f),
      ),
    )

  @Test
  fun `path golden vectors match iOS parity`() {
    for (v in pathVectors) {
      val p =
        computePinchFingerPositions(
          PinchStrokeGeometry(
            v.centerX,
            v.centerY,
            v.distanceStart,
            v.distanceEnd,
            v.rotationDegrees,
          ),
          fraction = v.fraction,
        )
      val actual = sortedPoints(listOf(p.x1 to p.y1, p.x2 to p.y2))
      val expected = sortedPoints(v.expected)
      actual.zip(expected).forEach { (a, e) ->
        assertEquals("x mismatch for $v", e.first, a.first, delta)
        assertEquals("y mismatch for $v", e.second, a.second, delta)
      }
    }
  }

  /** Deterministic order-independent sort so the golden comparison ignores finger labeling. */
  private fun sortedPoints(points: List<Pair<Float, Float>>): List<Pair<Float, Float>> =
    points.sortedWith(compareBy({ it.first }, { it.second }))
}
