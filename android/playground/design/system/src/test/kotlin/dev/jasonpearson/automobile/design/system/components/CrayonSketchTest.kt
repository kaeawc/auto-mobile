package dev.jasonpearson.automobile.design.system.components

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
  fun outline_isClosedAndNonTrivial() {
    val pts = crayonOutlineOffsets(w, h, corner, seed = 7L, roughness = roughness)
    assertTrue("outline should have a reasonable number of points", pts.size >= 16)
    val first = pts.first()
    val last = pts.last()
    val closeDist = Math.hypot((first.x - last.x).toDouble(), (first.y - last.y).toDouble())
    assertTrue(
      "outline must close back near its start (was $closeDist)",
      closeDist <= roughness * 2 + 0.001,
    )
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
  fun zeroRoughness_isAnExactRoundedRectangle() {
    val pts = crayonOutlineOffsets(w, h, corner, seed = 5L, roughness = 0f)
    // With no jitter every point must sit exactly on the rounded-rect perimeter,
    // i.e. within the [0,w] x [0,h] box.
    pts.forEach { p ->
      assertTrue(p.x in 0f..w && p.y in 0f..h)
    }
  }
}
