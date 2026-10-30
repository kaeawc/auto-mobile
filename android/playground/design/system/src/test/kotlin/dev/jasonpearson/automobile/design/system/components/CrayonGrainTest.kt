package dev.jasonpearson.automobile.design.system.components

import androidx.compose.ui.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CrayonGrainTest {
  @Test
  fun api33_usesShader() {
    assertEquals(CrayonGrainPath.SHADER, crayonGrainPath(33))
  }

  @Test
  fun api32_usesFallback() {
    assertEquals(CrayonGrainPath.FALLBACK, crayonGrainPath(32))
  }

  @Test
  fun minSdk24_usesFallback() {
    assertEquals(CrayonGrainPath.FALLBACK, crayonGrainPath(24))
  }

  @Test
  fun api36_usesShader() {
    assertEquals(CrayonGrainPath.SHADER, crayonGrainPath(36))
  }

  @Test
  fun fallbackModifier_drawsGrainInsteadOfReturningTheInput() {
    assertNotEquals(Modifier, Modifier.crayonGrain(sdkInt = 32))
    assertNotEquals(Modifier, Modifier.crayonGrain(sdkInt = 24))
  }

  @Test
  fun shaderModifier_drawsGrain() {
    assertNotEquals(Modifier, Modifier.crayonGrain(sdkInt = 33))
  }

  @Test
  fun grainAlpha_staysWithinTheSharedMaximum() {
    val alphas = (0 until 32).flatMap { x -> (0 until 32).map { y -> crayonGrainAlpha(x, y, 0f) } }
    assertTrue(alphas.all { it >= 0f && it <= CrayonGrainDefaults.MAX_ALPHA })
    // Grain, not a flat tint: the hash spreads across the alpha range.
    assertTrue(alphas.toSet().size > 100)
    assertTrue(alphas.max() > CrayonGrainDefaults.MAX_ALPHA * 0.9f)
  }

  @Test
  fun grainAlpha_originCellIsTransparentLikeTheShader() {
    // sin(0) == 0: the AGSL and Metal shaders also emit zero alpha at the origin cell.
    assertEquals(0f, crayonGrainAlpha(0, 0, 0f))
  }

  @Test
  fun grainAlpha_seedShiftsThePattern() {
    assertNotEquals(crayonGrainAlpha(3, 5, 0f), crayonGrainAlpha(3, 5, 1f))
    assertEquals(crayonGrainAlpha(4, 5, 0f), crayonGrainAlpha(3, 4, 1f))
  }

  @Test
  fun tilePixels_areBlackWithOneAlphaPerCell() {
    val cellPx = 3f
    val tilePx = 12
    val pixels = crayonGrainTilePixels(tilePx, cellPx, 0f)
    assertEquals(tilePx * tilePx, pixels.size)
    for (y in 0 until tilePx) {
      for (x in 0 until tilePx) {
        val argb = pixels[y * tilePx + x]
        assertEquals("rgb at ($x,$y)", 0, argb and 0x00FFFFFF)
        val expected = crayonGrainAlpha(x / 3, y / 3, 0f)
        assertEquals("alpha at ($x,$y)", Math.round(expected * 255f), argb ushr 24)
      }
    }
  }

  @Test
  fun tilePixels_neverExceedTheMaximumAlphaByte() {
    val maxByte = Math.round(CrayonGrainDefaults.MAX_ALPHA * 255f)
    val pixels = crayonGrainTilePixels(96, 4.5f, 0f)
    assertTrue(pixels.all { (it ushr 24) <= maxByte })
    assertTrue(pixels.map { it ushr 24 }.toSet().size > 5)
  }

  @Test
  fun tileSize_coversTheConfiguredCellCountAtAnyDensity() {
    assertEquals(48, crayonGrainTileSizePx(1.5f))
    assertEquals(144, crayonGrainTileSizePx(4.5f))
    assertEquals(1, crayonGrainTileSizePx(0f))
  }
}
