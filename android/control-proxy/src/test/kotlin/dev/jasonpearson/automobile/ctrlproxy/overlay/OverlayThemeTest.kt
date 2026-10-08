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
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class OverlayThemeTest {
  private fun model(root: OverlayNode) =
    mapOverlaySpec(OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), root = root))

  private val hiddenCondition = OverlayCondition("show", OverlayScalar.BooleanValue(true))

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
        children = listOf(OverlayBoxNode(style = styled("#101010"), children = emptyList())),
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
      scheme.primary.blue > scheme.primary.red && scheme.primary.blue > scheme.primary.green,
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
  fun `a system mode leaves the host chrome to the device even over an authored background`() {
    val dark = model(OverlayBoxNode(style = styled("#121316"), children = emptyList()))
    assertNull(overlayHostDark(dark.copy(theme = themed(mode = "system"))))
  }

  @Test
  fun `a mid light surface selects the light scheme so its text stays readable`() {
    val root = model(OverlayBoxNode(style = styled("#BBBBBB"), children = emptyList())).root
    val theme = overlayThemeSpec(root, false)
    assertFalse(theme.dark)
    val scheme = overlayColorScheme(theme)
    assertTrue(scheme.onSurface.contrastWith(scheme.surface) >= 4.5f)
  }

  @Test
  fun `hidden nodes do not decide the authored theme`() {
    val hidden =
      OverlayBoxNode(
        children =
          listOf(
            OverlayBoxNode(
              style = styled("#101010"),
              visibleWhen = hiddenCondition,
              children = emptyList(),
            ),
            OverlayBoxNode(style = styled("#FFFFFF"), children = emptyList()),
          ),
      )
    assertEquals(false, overlayAuthoredTheme(model(hidden).root)?.dark)
  }

  @Test
  fun `a grey seed stays grey`() {
    val scheme = overlaySeedColorScheme(Color(0xFF808080), dark = false)
    assertEquals(scheme.primary.red, scheme.primary.green, 0.01f)
    assertEquals(scheme.primary.green, scheme.primary.blue, 0.01f)
  }

  @Test
  fun `a bright seed still gives a legible primary and content colour`() {
    for (dark in listOf(false, true)) {
      val scheme = overlaySeedColorScheme(Color(0xFFFFFF00), dark)
      assertTrue(
        "primary on surface, dark=$dark",
        scheme.primary.contrastWith(scheme.surface) >= 3f,
      )
      assertTrue("onPrimary, dark=$dark", scheme.onPrimary.contrastWith(scheme.primary) >= 4.5f)
    }
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
  fun `colour roles resolve against the scheme and hex colours stay literal`() {
    val scheme = lightColorScheme(primary = Color(0xFF123456), surfaceContainer = Color(0xFF654321))
    assertEquals(Color(0xFF123456), overlayColorRole(scheme, "primary"))
    assertEquals(Color(0xFF654321), overlayColorRole(scheme, "surfaceContainer"))
    assertNull(overlayColorRole(scheme, "onPurple"))
    assertEquals(Color(0xFF123456), overlayResolveColor(scheme, null, "primary"))
    assertEquals(Color.Red, overlayResolveColor(scheme, Color.Red, "#FFFF0000"))
    assertEquals(Color.Red, overlayResolveColor(scheme, Color.Red, null))
    assertNull(overlayResolveColor(scheme, null, null))
  }

  @Test
  fun `colour role tokens map to no literal colour and hex stays parsed`() {
    val style = mapOverlayStyle(OverlayStyle(background = "surface", color = "#112233"))
    assertNull(style.background)
    assertEquals(Color(0xFF112233), style.color)
    assertEquals(Color.Unspecified, mapOverlayStyle(OverlayStyle(color = "onSurface")).color)
  }

  @Test
  fun `corner tokens map to the theme's shape steps and dp stays literal`() {
    val shapes = Shapes(large = RoundedCornerShape(11.dp))
    assertEquals(shapes.large, overlayCornerShape(shapes, OverlayCornerRadius.Token("large")))
    assertEquals(shapes.small, overlayCornerShape(shapes, OverlayCornerRadius.Token("small")))
    assertEquals(
      RoundedCornerShape(0.dp),
      overlayCornerShape(shapes, OverlayCornerRadius.Token("none")),
    )
    assertEquals(
      RoundedCornerShape(percent = 50),
      overlayCornerShape(shapes, OverlayCornerRadius.Token("full")),
    )
    assertEquals(
      RoundedCornerShape(6.dp),
      overlayCornerShape(shapes, OverlayCornerRadius.Dp(6.0)),
    )
  }

  @Test
  fun `cornerRadius decodes dp and tokens and rejects unknown tokens`() {
    val json = kotlinx.serialization.json.Json
    assertEquals(
      OverlayCornerRadius.Dp(4.0),
      json.decodeFromString(OverlayCornerRadiusSerializer, "4"),
    )
    assertEquals(
      OverlayCornerRadius.Token("extraLarge"),
      json.decodeFromString(OverlayCornerRadiusSerializer, "\"extraLarge\""),
    )
    assertThrows(kotlinx.serialization.SerializationException::class.java) {
      json.decodeFromString(OverlayCornerRadiusSerializer, "\"huge\"")
    }
  }

  @Test
  fun `host dismiss colours are translucent and contrast with the scheme`() {
    val dark = overlayDismissColors(true)
    val light = overlayDismissColors(false)
    assertTrue(dark.background.alpha < 1f && light.background.alpha < 1f)
    assertNotEquals(dark.content, light.content)
  }

  private val roleNames =
    OverlaySpecThemeColors.serializer().descriptor.let { d ->
      (0 until d.elementsCount).map(d::getElementName) - setOf("seed", "source")
    }

  @Test
  fun `every role override replaces exactly the role it names`() {
    assertEquals(36, roleNames.size)
    val base = lightColorScheme()
    roleNames.forEach { role ->
      val colors = Json.decodeFromString<OverlaySpecThemeColors>("""{"$role":"#010203"}""")
      val scheme = base.withRoleOverrides(colors)
      assertEquals(role, Color(0xFF010203), overlayColorRole(scheme, role))
      roleNames
        .filter { it != role }
        .forEach { assertEquals(role, overlayColorRole(base, it), overlayColorRole(scheme, it)) }
    }
  }

  @Test
  fun `role overrides apply over a seed scheme and keep the rest of it`() {
    val root = model(OverlaySpacerNode()).root
    val theme =
      overlayThemeSpec(
        root,
        false,
        OverlaySpecTheme(
          mode = "light",
          colors = OverlaySpecThemeColors(seed = "#6750A4", primary = "#FF0000"),
        ),
      )
    val scheme = overlayColorScheme(theme)
    val seeded = overlaySeedColorScheme(Color(0xFF6750A4), false)
    assertEquals(Color(0xFFFF0000), scheme.primary)
    assertEquals(seeded.secondary, scheme.secondary)
    assertEquals(seeded.surface, scheme.surface)
  }

  @Test
  fun `role overrides apply over the device scheme too`() {
    val theme =
      overlayThemeSpec(
        model(OverlaySpacerNode()).root,
        false,
        OverlaySpecTheme(colors = OverlaySpecThemeColors(source = "device", error = "#00FF00")),
      )
    val dynamic = lightColorScheme(primary = Color(0xFF123456))
    val scheme = overlayColorScheme(theme, dynamic)
    assertEquals(Color(0xFF123456), scheme.primary)
    assertEquals(Color(0xFF00FF00), scheme.error)
  }

  @Test
  fun `with no mode a dark background override selects dark for content and host chrome`() {
    val lightAuthored = model(OverlayBoxNode(style = styled("#FFFFFF"), children = emptyList()))
    val explicit =
      OverlaySpecTheme(colors = OverlaySpecThemeColors(background = "#101010", primary = "#FF0000"))
    val theme = overlayThemeSpec(lightAuthored.root, false, explicit)
    assertTrue(theme.dark)
    assertNull(theme.surface) // the light authored background must not paint a dark scheme
    assertEquals(Color(0xFF101010), overlayColorScheme(theme).background)
    assertEquals(darkColorScheme().onSurface, overlayColorScheme(theme).onSurface)
    assertEquals(true, overlayHostDark(lightAuthored.copy(theme = explicit)))
  }

  @Test
  fun `an explicit mode still wins over a background override`() {
    val explicit =
      OverlaySpecTheme(mode = "light", colors = OverlaySpecThemeColors(surface = "#101010"))
    val root = model(OverlaySpacerNode())
    assertFalse(overlayThemeSpec(root.root, true, explicit).dark)
    assertEquals(false, overlayHostDark(root.copy(theme = explicit)))
  }
}
