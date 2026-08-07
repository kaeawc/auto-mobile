package dev.jasonpearson.automobile.design.system.components

import androidx.compose.ui.geometry.Offset
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the hand-drawn "crayon" outline geometry (AC1). The perimeter must be a deterministic,
 * seeded jitter of a rounded rectangle — deterministic so the look is screenshot-testable and never
 * flakes, and bounded so the wobble stays a sketchy edge rather than spilling out of the component.
 * Pure `Offset` maths, so this runs as a fast host test (no `android.graphics.Path`).
 */
class CrayonSketchTest {

  private val w = 200f
  private val h = 96f
  private val corner = 18f
  private val roughness = 3f

  @Test
  fun sameSeed_producesIdenticalOutline() {
    val a = crayonOutlineOffsets(w, h, corner, seed = 42L, roughness = roughness)
    val b = crayonOutlineOffsets(w, h, corner, seed = 42L, roughness = roughness)
    assertEquals("outline must be deterministic for a given seed", a, b)
  }

  @Test
  fun differentSeed_producesDifferentOutline() {
    val a = crayonOutlineOffsets(w, h, corner, seed = 1L, roughness = roughness)
    val b = crayonOutlineOffsets(w, h, corner, seed = 2L, roughness = roughness)
    assertNotEquals("different seeds must jitter differently", a, b)
  }

  @Test
  fun outline_isClosedExactly() {
    val pts = crayonOutlineOffsets(w, h, corner, seed = 7L, roughness = roughness)
    assertTrue("outline should have a reasonable number of points", pts.size >= 16)
    assertEquals("outline must close exactly: last point == first point", pts.first(), pts.last())
  }

  @Test
  fun everyPoint_staysWithinRoughnessBounds() {
    val pts = crayonOutlineOffsets(w, h, corner, seed = 99L, roughness = roughness)
    pts.forEach { p ->
      assertTrue(
        "x ${p.x} within [-r, w+r]",
        p.x >= -roughness - 0.001f && p.x <= w + roughness + 0.001f,
      )
      assertTrue(
        "y ${p.y} within [-r, h+r]",
        p.y >= -roughness - 0.001f && p.y <= h + roughness + 0.001f,
      )
    }
  }

  @Test
  fun zeroRoughness_hasNoDuplicateSeamPoints() {
    // Each perimeter seam is sampled once: with no jitter only the closing point
    // (last == first) may repeat — no interior consecutive duplicates. A duplicated
    // arc/edge seam point would jitter independently and render as a knot.
    val pts = crayonOutlineOffsets(w, h, corner, seed = 3L, roughness = 0f)
    for (i in 1 until pts.size - 1) {
      assertNotEquals("duplicate seam point at index $i: ${pts[i]}", pts[i - 1], pts[i])
    }
  }

  @Test
  fun nonPositiveSegmentsPerEdge_clampToOne() {
    // Zero or negative segmentsPerEdge must not throw and must behave like 1.
    val one = crayonOutlineOffsets(w, h, corner, seed = 8L, roughness = 0f, segmentsPerEdge = 1)
    for (bad in listOf(0, -1, -7)) {
      val got = crayonOutlineOffsets(w, h, corner, seed = 8L, roughness = 0f, segmentsPerEdge = bad)
      assertEquals("segmentsPerEdge $bad should clamp to 1", one, got)
    }
  }

  @Test
  fun zeroRoughness_isAnExactRoundedRectangle() {
    val pts = crayonOutlineOffsets(w, h, corner, seed = 5L, roughness = 0f)
    // With no jitter every point must sit ON the rounded-rect perimeter — a
    // straight edge or a corner arc — not merely inside the bounding box.
    pts.forEach { p ->
      assertTrue("point $p must lie on the perimeter", onPerimeter(p, w, h, corner))
    }
  }

  private fun onPerimeter(p: Offset, w: Float, h: Float, cornerRadius: Float): Boolean {
    val r = cornerRadius.coerceIn(0f, min(w, h) / 2f)
    val eps = 0.05f
    fun near(a: Float, b: Float) = abs(a - b) < eps
    // straight edges
    if (near(p.y, 0f) && p.x >= r - eps && p.x <= w - r + eps) return true
    if (near(p.y, h) && p.x >= r - eps && p.x <= w - r + eps) return true
    if (near(p.x, 0f) && p.y >= r - eps && p.y <= h - r + eps) return true
    if (near(p.x, w) && p.y >= r - eps && p.y <= h - r + eps) return true
    // corner arcs: distance from a corner-arc centre equals the radius
    val centres = listOf(Offset(r, r), Offset(w - r, r), Offset(r, h - r), Offset(w - r, h - r))
    return centres.any { c -> abs(hypot((p.x - c.x).toDouble(), (p.y - c.y).toDouble()) - r) < eps }
  }
}
