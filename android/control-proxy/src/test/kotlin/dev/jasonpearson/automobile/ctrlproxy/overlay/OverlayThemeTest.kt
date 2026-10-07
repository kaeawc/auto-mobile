package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class OverlayThemeTest {
  private fun model(root: OverlayNode) =
    mapOverlaySpec(OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), root = root))

  private fun styled(background: String?) = OverlayStyle(background = background)

  @Test
  fun `a dark root background selects the dark scheme and sets surfaces to it`() {
    val theme =
      overlayThemeSpec(
        model(OverlayBoxNode(style = styled("#121316"), children = emptyList())).root,
        false,
      )
    assertTrue(theme.dark)
    val scheme = overlayColorScheme(theme)
    assertEquals(Color(0xFF121316), scheme.surface)
    assertEquals(Color(0xFF121316), scheme.surfaceContainer)
  }

  @Test
  fun `a light background wins over a dark device setting`() {
    val root = model(OverlayBoxNode(style = styled("#FFFFFF"), children = emptyList())).root
    assertFalse(overlayThemeSpec(root, true).dark)
  }

  @Test
  fun `the leading chain is searched when the root paints nothing`() {
    val nested =
      OverlayBoxNode(
        children = listOf(OverlayBoxNode(style = styled("#101010"), children = emptyList()))
      )
    assertNull(overlayAuthoredTheme(model(OverlaySpacerNode()).root))
    assertEquals(true, overlayAuthoredTheme(model(nested).root)?.dark)
  }

  @Test
  fun `a spec with no opaque background follows the device setting`() {
    val root = model(OverlayBoxNode(style = styled("#80000000"), children = emptyList())).root
    assertNull(overlayAuthoredTheme(root))
    assertTrue(overlayThemeSpec(root, true).dark)
    assertFalse(overlayThemeSpec(root, false).dark)
    assertNull(overlayThemeSpec(root, true).surface)
  }

  private fun themed(mode: String? = null, seed: String? = null, source: String? = null) =
    OverlaySpecTheme(
      mode,
      if (seed != null || source != null) OverlaySpecThemeColors(seed, source) else null,
    )

  @Test
  fun `an explicit mode wins over the authored background`() {
    val dark = model(OverlayBoxNode(style = styled("#121316"), children = emptyList())).root
    val light = overlayThemeSpec(dark, true, themed(mode = "light"))
    assertFalse(light.dark)
    assertNull(light.surface) // a dark background must not paint a light scheme
    assertTrue(overlayThemeSpec(dark, false, themed(mode = "dark")).dark)
    assertEquals(Color(0xFF121316), overlayThemeSpec(dark, false, themed(mode = "dark")).surface)
    assertTrue(overlayThemeSpec(dark, true, themed(mode = "system")).dark)
    assertFalse(overlayThemeSpec(dark, false, themed(mode = "system")).dark)
  }

  @Test
  fun `a seed colour generates a scheme that replaces the authored surface`() {
    val root = model(OverlayBoxNode(style = styled("#121316"), children = emptyList())).root
    val theme = overlayThemeSpec(root, false, themed(seed = "#6750A4"))
    assertNull(theme.surface)
    val light = overlayColorScheme(theme.copy(dark = false))
    val dark = overlayColorScheme(theme.copy(dark = true))
    assertNotEquals(light.primary, dark.primary)
    assertTrue(light.surface.luminance() > 0.5f)
    assertTrue(dark.surface.luminance() < 0.5f)
    assertTrue(light.primary.luminance() < light.primaryContainer.luminance())
  }

  @Test
  fun `a seed keeps its hue in the primary colour`() {
    val scheme = overlaySeedColorScheme(Color(0xFF0000FF), dark = false)
    assertTrue(
      scheme.primary.blue > scheme.primary.red && scheme.primary.blue > scheme.primary.green
    )
  }

  @Test
  fun `device colour uses the dynamic scheme only when one is supplied`() {
    val root = model(OverlaySpacerNode()).root
    val theme = overlayThemeSpec(root, false, themed(seed = "#6750A4", source = "device"))
    assertTrue(theme.dynamicColor)
    val dynamic = darkColorScheme(primary = Color(0xFF123456))
    assertSame(dynamic, overlayColorScheme(theme, dynamic))
    // Below API 31 no dynamic scheme exists: the seed is the fallback.
    assertEquals(
      overlaySeedColorScheme(Color(0xFF6750A4), false).primary,
      overlayColorScheme(theme, null).primary,
    )
    assertEquals(
      lightColorScheme().primary,
      overlayColorScheme(overlayThemeSpec(root, false, themed(source = "device"))).primary,
    )
  }

  @Test
  fun `the host chrome follows an explicit mode`() {
    val dark = model(OverlayBoxNode(style = styled("#121316"), children = emptyList()))
    assertEquals(true, overlayHostDark(dark))
    assertEquals(false, overlayHostDark(dark.copy(theme = themed(mode = "light"))))
    assertNull(overlayHostDark(model(OverlaySpacerNode())))
  }

  @Test
  fun `no typography keeps the stock Material scale`() {
    assertEquals(Typography().titleLarge, overlayTypography(null).titleLarge)
    assertEquals(Typography().bodySmall, overlayTypography(OverlaySpecThemeTypography()).bodySmall)
  }

  @Test
  fun `a scale multiplies every role's size and line height`() {
    val base = Typography()
    val scaled = overlayTypography(OverlaySpecThemeTypography(scale = 1.5))
    assertEquals(base.bodyMedium.fontSize.value * 1.5f, scaled.bodyMedium.fontSize.value, 0.001f)
    assertEquals(
      base.displayLarge.fontSize.value * 1.5f,
      scaled.displayLarge.fontSize.value,
      0.001f,
    )
    assertEquals(
      base.labelSmall.lineHeight.value * 1.5f,
      scaled.labelSmall.lineHeight.value,
      0.001f,
    )
    assertEquals(base.titleLarge.fontWeight, scaled.titleLarge.fontWeight)
  }

  @Test
  fun `a font family replaces the family of every role`() {
    assertEquals(
      FontFamily.Serif,
      overlayTypography(OverlaySpecThemeTypography(fontFamily = "serif")).headlineSmall.fontFamily,
    )
    assertEquals(
      FontFamily.Monospace,
      overlayTypography(OverlaySpecThemeTypography(fontFamily = "mono")).labelLarge.fontFamily,
    )
    assertEquals(
      FontFamily.SansSerif,
      overlayTypography(OverlaySpecThemeTypography(fontFamily = "sans")).bodyLarge.fontFamily,
    )
  }

  @Test
  fun `text style tokens resolve to their Material roles`() {
    val typography = Typography()
    assertEquals(typography.titleLarge, overlayTextRole(typography, "titleLarge"))
    assertEquals(typography.displaySmall, overlayTextRole(typography, "displaySmall"))
    assertEquals(typography.labelMedium, overlayTextRole(typography, "labelMedium"))
    assertNull(overlayTextRole(typography, null))
    assertNull(overlayTextRole(typography, "headline"))
  }

  @Test
  fun `corner choices map to Material shape families`() {
    assertEquals(Shapes(), overlayShapes(null))
    assertEquals(Shapes(), overlayShapes(OverlaySpecThemeShapes("medium")))
    assertEquals(RoundedCornerShape(0.dp), overlayShapes(OverlaySpecThemeShapes("none")).large)
    val small = overlayShapes(OverlaySpecThemeShapes("small"))
    val large = overlayShapes(OverlaySpecThemeShapes("large"))
    assertEquals(RoundedCornerShape(8.dp), small.large)
    assertEquals(RoundedCornerShape(28.dp), large.large)
    assertEquals(RoundedCornerShape(2.dp), small.extraSmall)
    val full = overlayShapes(OverlaySpecThemeShapes("full"))
    assertEquals(RoundedCornerShape(percent = 50), full.extraSmall)
    assertEquals(RoundedCornerShape(percent = 50), full.extraLarge)
  }

  @Test
  fun `host dismiss colours are translucent and contrast with the scheme`() {
    val dark = overlayDismissColors(true)
    val light = overlayDismissColors(false)
    assertTrue(dark.background.alpha < 1f && light.background.alpha < 1f)
    assertNotEquals(dark.content, light.content)
  }
}
