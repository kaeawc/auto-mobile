package dev.jasonpearson.automobile.design.system.components

import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the 1-D hand-drawn "crayon line" geometry (#5115): a deterministic, seeded perpendicular
 * jitter of a straight baseline, used for the divider strokes on the top app bar / bottom nav.
 * Deterministic so the look is screenshot-testable and never flakes; bounded so the wobble stays a
 * sketchy line rather than a spilling scribble; endpoints anchored so the divider spans the full
 * width. Pure `Offset` maths, so this runs as a fast host test.
 */
class CrayonLineTest {

  private val length = 320f
  private val roughness = 2.5f

  @Test
  fun sameSeed_producesIdenticalLine() {
    val a = crayonLinePoints(length, seed = 42L, roughness = roughness)
    val b = crayonLinePoints(length, seed = 42L, roughness = roughness)
    assertEquals("line must be deterministic for a given seed", a, b)
  }

  @Test
  fun differentSeed_producesDifferentLine() {
    val a = crayonLinePoints(length, seed = 1L, roughness = roughness)
    val b = crayonLinePoints(length, seed = 2L, roughness = roughness)
    assertNotEquals("different seeds must jitter differently", a, b)
  }

  @Test
  fun line_spansFullLengthExactly() {
    val pts = crayonLinePoints(length, seed = 7L, roughness = roughness)
    assertTrue("line should have a reasonable number of points", pts.size >= 4)
    assertEquals("first point anchored at x=0", 0f, pts.first().x, 0.0001f)
    assertEquals("last point anchored at x=length", length, pts.last().x, 0.0001f)
  }

  @Test
  fun pointCount_matchesSegmentsPlusOne() {
    val pts = crayonLinePoints(length, seed = 5L, roughness = roughness, segments = 10)
    assertEquals("segments+1 samples", 11, pts.size)
  }

  @Test
  fun everyPoint_staysWithinBounds() {
    val pts = crayonLinePoints(length, seed = 99L, roughness = roughness)
    pts.forEach { p ->
      assertTrue("x ${p.x} within [0, length]", p.x >= -0.0001f && p.x <= length + 0.0001f)
      assertTrue("y ${p.y} within [-r, r]", abs(p.y) <= roughness + 0.0001f)
    }
  }

  @Test
  fun xIsMonotonicNonDecreasing() {
    val pts = crayonLinePoints(length, seed = 11L, roughness = roughness)
    for (i in 1 until pts.size) {
      assertTrue("x must not go backwards at $i", pts[i].x >= pts[i - 1].x - 0.0001f)
    }
  }

  @Test
  fun nonPositiveSegments_clampToOne() {
    // Zero or negative segments must not throw and must behave like 1 (a 2-point line).
    val one = crayonLinePoints(length, seed = 8L, roughness = 0f, segments = 1)
    for (bad in listOf(0, -1, -7)) {
      val got = crayonLinePoints(length, seed = 8L, roughness = 0f, segments = bad)
      assertEquals("segments $bad should clamp to 1", one, got)
    }
  }

  @Test
  fun zeroRoughness_isAFlatBaseline() {
    val pts = crayonLinePoints(length, seed = 3L, roughness = 0f, segments = 8)
    pts.forEach { p -> assertEquals("no jitter => y == 0", 0f, p.y, 0.0001f) }
  }
}
