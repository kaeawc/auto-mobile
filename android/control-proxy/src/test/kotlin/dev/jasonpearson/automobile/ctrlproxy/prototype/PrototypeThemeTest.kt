package dev.jasonpearson.automobile.ctrlproxy.prototype

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
import kotlin.math.abs
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class PrototypeThemeTest {
  private fun model(root: PrototypeNode) =
    mapPrototypeSpec(
      PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), root = root),
    )

  private val hiddenCondition = PrototypeCondition("show", PrototypeScalar.BooleanValue(true))

  private fun styled(background: String?) =
    PrototypeStyle(background = background?.let(PrototypeModeValue::Single))

  @Test
  fun `a dark root background selects the dark scheme and sets surfaces to it`() {
    val theme =
      prototypeThemeSpec(
        model(PrototypeBoxNode(style = styled("#121316"), children = emptyList())).root,
        false,
      )
    assertTrue(theme.dark)
    val scheme = prototypeColorScheme(theme)
    assertEquals(Color(0xFF121316), scheme.surface)
    assertEquals(Color(0xFF121316), scheme.surfaceContainer)
  }

  @Test
  fun `a light background wins over a dark device setting`() {
    val root = model(PrototypeBoxNode(style = styled("#FFFFFF"), children = emptyList())).root
    assertFalse(prototypeThemeSpec(root, true).dark)
  }

  @Test
  fun `the leading chain is searched when the root paints nothing`() {
    val nested =
      PrototypeBoxNode(
        children = listOf(PrototypeBoxNode(style = styled("#101010"), children = emptyList())),
      )
    assertNull(prototypeAuthoredTheme(model(PrototypeSpacerNode()).root))
    assertEquals(true, prototypeAuthoredTheme(model(nested).root)?.dark)
  }

  @Test
  fun `a spec with no opaque background follows the device setting`() {
    val root = model(PrototypeBoxNode(style = styled("#80000000"), children = emptyList())).root
    assertNull(prototypeAuthoredTheme(root))
    assertTrue(prototypeThemeSpec(root, true).dark)
    assertFalse(prototypeThemeSpec(root, false).dark)
    assertNull(prototypeThemeSpec(root, true).surface)
  }

  private fun themed(mode: String? = null, seed: String? = null, source: String? = null) =
    PrototypeSpecTheme(
      mode,
      if (seed != null || source != null) PrototypeSpecThemeColors(seed, source) else null,
    )

  @Test
  fun `an explicit mode wins over the authored background`() {
    val dark = model(PrototypeBoxNode(style = styled("#121316"), children = emptyList())).root
    val light = prototypeThemeSpec(dark, true, themed(mode = "light"))
    assertFalse(light.dark)
    assertNull(light.surface) // a dark background must not paint a light scheme
    assertTrue(prototypeThemeSpec(dark, false, themed(mode = "dark")).dark)
    assertEquals(Color(0xFF121316), prototypeThemeSpec(dark, false, themed(mode = "dark")).surface)
    assertTrue(prototypeThemeSpec(dark, true, themed(mode = "system")).dark)
    assertFalse(prototypeThemeSpec(dark, false, themed(mode = "system")).dark)
  }

  @Test
  fun `a seed colour generates a scheme that replaces the authored surface`() {
    val root = model(PrototypeBoxNode(style = styled("#121316"), children = emptyList())).root
    val theme = prototypeThemeSpec(root, false, themed(seed = "#6750A4"))
    assertNull(theme.surface)
    val light = prototypeColorScheme(theme.copy(dark = false))
    val dark = prototypeColorScheme(theme.copy(dark = true))
    assertNotEquals(light.primary, dark.primary)
    assertTrue(light.surface.luminance() > 0.5f)
    assertTrue(dark.surface.luminance() < 0.5f)
    assertTrue(light.primary.luminance() < light.primaryContainer.luminance())
  }

  @Test
  fun `a seed keeps its hue in the primary colour`() {
    val scheme = prototypeSeedColorScheme(Color(0xFF0000FF), dark = false)
    assertTrue(
      scheme.primary.blue > scheme.primary.red && scheme.primary.blue > scheme.primary.green,
    )
  }

  @Test
  fun `device colour uses the dynamic scheme only when one is supplied`() {
    val root = model(PrototypeSpacerNode()).root
    val theme = prototypeThemeSpec(root, false, themed(seed = "#6750A4", source = "device"))
    assertTrue(theme.dynamicColor)
    val dynamic = darkColorScheme(primary = Color(0xFF123456))
    assertSame(dynamic, prototypeColorScheme(theme, dynamic))
    // Below API 31 no dynamic scheme exists: the seed is the fallback.
    assertEquals(
      prototypeSeedColorScheme(Color(0xFF6750A4), false).primary,
      prototypeColorScheme(theme, null).primary,
    )
    assertEquals(
      lightColorScheme().primary,
      prototypeColorScheme(prototypeThemeSpec(root, false, themed(source = "device"))).primary,
    )
  }

  @Test
  fun `the host chrome follows an explicit mode`() {
    val dark = model(PrototypeBoxNode(style = styled("#121316"), children = emptyList()))
    assertEquals(true, prototypeHostDark(dark))
    assertEquals(false, prototypeHostDark(dark.copy(theme = themed(mode = "light"))))
    assertNull(prototypeHostDark(model(PrototypeSpacerNode())))
  }

  @Test
  fun `a system mode leaves the host chrome to the device even over an authored background`() {
    val dark = model(PrototypeBoxNode(style = styled("#121316"), children = emptyList()))
    assertNull(prototypeHostDark(dark.copy(theme = themed(mode = "system"))))
  }

  @Test
  fun `a mid light surface selects the light scheme so its text stays readable`() {
    val root = model(PrototypeBoxNode(style = styled("#BBBBBB"), children = emptyList())).root
    val theme = prototypeThemeSpec(root, false)
    assertFalse(theme.dark)
    val scheme = prototypeColorScheme(theme)
    assertTrue(scheme.onSurface.contrastWith(scheme.surface) >= 4.5f)
  }

  @Test
  fun `hidden nodes do not decide the authored theme`() {
    val hidden =
      PrototypeBoxNode(
        children =
          listOf(
            PrototypeBoxNode(
              style = styled("#101010"),
              visibleWhen = hiddenCondition,
              children = emptyList(),
            ),
            PrototypeBoxNode(style = styled("#FFFFFF"), children = emptyList()),
          ),
      )
    assertEquals(false, prototypeAuthoredTheme(model(hidden).root)?.dark)
  }

  @Test
  fun `a grey seed stays grey`() {
    val scheme = prototypeSeedColorScheme(Color(0xFF808080), dark = false)
    assertEquals(scheme.primary.red, scheme.primary.green, 0.01f)
    assertEquals(scheme.primary.green, scheme.primary.blue, 0.01f)
  }

  @Test
  fun `a bright seed still gives a legible primary and content colour`() {
    for (dark in listOf(false, true)) {
      val scheme = prototypeSeedColorScheme(Color(0xFFFFFF00), dark)
      assertTrue(
        "primary on surface, dark=$dark",
        scheme.primary.contrastWith(scheme.surface) >= 3f,
      )
      assertTrue("onPrimary, dark=$dark", scheme.onPrimary.contrastWith(scheme.primary) >= 4.5f)
    }
  }

  @Test
  fun `no typography keeps the stock Material scale`() {
    assertEquals(Typography().titleLarge, prototypeTypography(null).titleLarge)
    assertEquals(
      Typography().bodySmall,
      prototypeTypography(PrototypeSpecThemeTypography()).bodySmall,
    )
  }

  @Test
  fun `a scale multiplies every role's size and line height`() {
    val base = Typography()
    val scaled = prototypeTypography(PrototypeSpecThemeTypography(scale = 1.5))
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
      prototypeTypography(PrototypeSpecThemeTypography(fontFamily = "serif"))
        .headlineSmall
        .fontFamily,
    )
    assertEquals(
      FontFamily.Monospace,
      prototypeTypography(PrototypeSpecThemeTypography(fontFamily = "mono")).labelLarge.fontFamily,
    )
    assertEquals(
      FontFamily.SansSerif,
      prototypeTypography(PrototypeSpecThemeTypography(fontFamily = "sans")).bodyLarge.fontFamily,
    )
  }

  @Test
  fun `text style tokens resolve to their Material roles`() {
    val typography = Typography()
    assertEquals(typography.titleLarge, prototypeTextRole(typography, "titleLarge"))
    assertEquals(typography.displaySmall, prototypeTextRole(typography, "displaySmall"))
    assertEquals(typography.labelMedium, prototypeTextRole(typography, "labelMedium"))
    assertNull(prototypeTextRole(typography, null))
    assertNull(prototypeTextRole(typography, "headline"))
  }

  @Test
  fun `corner choices map to Material shape families`() {
    assertEquals(Shapes(), prototypeShapes(null))
    assertEquals(Shapes(), prototypeShapes(PrototypeSpecThemeShapes("medium")))
    assertEquals(RoundedCornerShape(0.dp), prototypeShapes(PrototypeSpecThemeShapes("none")).large)
    val small = prototypeShapes(PrototypeSpecThemeShapes("small"))
    val large = prototypeShapes(PrototypeSpecThemeShapes("large"))
    assertEquals(RoundedCornerShape(8.dp), small.large)
    assertEquals(RoundedCornerShape(28.dp), large.large)
    assertEquals(RoundedCornerShape(2.dp), small.extraSmall)
    val full = prototypeShapes(PrototypeSpecThemeShapes("full"))
    assertEquals(RoundedCornerShape(percent = 50), full.extraSmall)
    assertEquals(RoundedCornerShape(percent = 50), full.extraLarge)
  }

  @Test
  fun `colour roles resolve against the scheme and hex colours stay literal`() {
    val scheme = lightColorScheme(primary = Color(0xFF123456), surfaceContainer = Color(0xFF654321))
    assertEquals(Color(0xFF123456), prototypeColorRole(scheme, "primary"))
    assertEquals(Color(0xFF654321), prototypeColorRole(scheme, "surfaceContainer"))
    assertNull(prototypeColorRole(scheme, "onPurple"))
    assertEquals(Color(0xFF123456), prototypeResolveColor(scheme, null, "primary"))
    assertEquals(Color.Red, prototypeResolveColor(scheme, Color.Red, "#FFFF0000"))
    assertEquals(Color.Red, prototypeResolveColor(scheme, Color.Red, null))
    assertNull(prototypeResolveColor(scheme, null, null))
  }

  @Test
  fun `colour role tokens map to no literal colour and hex stays parsed`() {
    val style =
      mapPrototypeStyle(
        PrototypeStyle(
          background = PrototypeModeValue.Single("surface"),
          color = PrototypeModeValue.Single("#112233"),
        ),
      )
    assertNull(style.background)
    assertEquals(Color(0xFF112233), style.color)
    assertEquals(
      Color.Unspecified,
      mapPrototypeStyle(PrototypeStyle(color = PrototypeModeValue.Single("onSurface"))).color,
    )
  }

  @Test
  fun `corner tokens map to the theme's shape steps and dp stays literal`() {
    val shapes = Shapes(large = RoundedCornerShape(11.dp))
    assertEquals(shapes.large, prototypeCornerShape(shapes, PrototypeCornerRadius.Token("large")))
    assertEquals(shapes.small, prototypeCornerShape(shapes, PrototypeCornerRadius.Token("small")))
    assertEquals(
      RoundedCornerShape(0.dp),
      prototypeCornerShape(shapes, PrototypeCornerRadius.Token("none")),
    )
    assertEquals(
      RoundedCornerShape(percent = 50),
      prototypeCornerShape(shapes, PrototypeCornerRadius.Token("full")),
    )
    assertEquals(
      RoundedCornerShape(6.dp),
      prototypeCornerShape(shapes, PrototypeCornerRadius.Dp(6.0)),
    )
  }

  @Test
  fun `cornerRadius decodes dp and tokens and rejects unknown tokens`() {
    val json = kotlinx.serialization.json.Json
    assertEquals(
      PrototypeCornerRadius.Dp(4.0),
      json.decodeFromString(PrototypeCornerRadiusSerializer, "4"),
    )
    assertEquals(
      PrototypeCornerRadius.Token("extraLarge"),
      json.decodeFromString(PrototypeCornerRadiusSerializer, "\"extraLarge\""),
    )
    assertThrows(kotlinx.serialization.SerializationException::class.java) {
      json.decodeFromString(PrototypeCornerRadiusSerializer, "\"huge\"")
    }
  }

  @Test
  fun `per-corner radii decode, round-trip and render with omitted corners square`() {
    val json = kotlinx.serialization.json.Json
    val corners =
      json.decodeFromString(PrototypeCornerRadiusSerializer, """{"topStart":16,"topEnd":4.5}""")
    assertEquals(PrototypeCornerRadius.Corners(topStart = 16.0, topEnd = 4.5), corners)
    assertEquals(
      """{"topStart":16.0,"topEnd":4.5}""",
      json.encodeToString(PrototypeCornerRadiusSerializer, corners),
    )
    assertEquals(
      RoundedCornerShape(topStart = 16.dp, topEnd = 4.5.dp, bottomEnd = 0.dp, bottomStart = 0.dp),
      prototypeCornerShape(Shapes(), corners),
    )
    for (bad in listOf("""{"top":1}""", """{"topStart":-1}""", """{"topStart":"4"}""")) {
      assertThrows(bad, kotlinx.serialization.SerializationException::class.java) {
        json.decodeFromString(PrototypeCornerRadiusSerializer, bad)
      }
    }
  }

  @Test
  fun `host dismiss and close colours come from the scheme roles and contrast`() {
    for (scheme in listOf(lightColorScheme(), darkColorScheme())) {
      val bar = prototypeDismissColors(scheme)
      assertEquals(
        scheme.surfaceContainerHigh.copy(alpha = PROTOTYPE_DISMISS_BAR_ALPHA),
        bar.background,
      )
      assertEquals(scheme.onSurface, bar.content)
      assertTrue(bar.background.alpha < 1f)
      val close = prototypeCloseColors(scheme)
      assertEquals(scheme.surfaceContainerHigh, close.background)
      assertEquals(scheme.onSurface, close.content)
      assertTrue(abs(close.background.luminance() - close.content.luminance()) > 0.3f)
    }
    // The dark scheme's Close control is a dark block, not the old white one.
    assertTrue(prototypeCloseColors(darkColorScheme()).background.luminance() < 0.2f)
  }

  @Test
  fun `host dismiss colours follow an explicit spec theme`() {
    val theme =
      prototypeColorScheme(
        PrototypeThemeSpec(
          dark = true,
          surface = null,
          roles =
            Json.decodeFromString("""{"surfaceContainerHigh":"#102030","onSurface":"#F0E0D0"}"""),
        ),
      )
    assertEquals(Color(0xFF102030), prototypeCloseColors(theme).background)
    assertEquals(Color(0xFFF0E0D0), prototypeDismissColors(theme).content)
  }

  @Test
  fun `sheet handle scrims and placeholders use scheme roles`() {
    for (scheme in listOf(lightColorScheme(), darkColorScheme())) {
      assertEquals(scheme.onSurfaceVariant, prototypeHandleColor(scheme))
      assertEquals(scheme.scrim.copy(alpha = 0.4f), prototypeSheetScrimFallback(scheme))
      assertEquals(scheme.scrim.copy(alpha = 0.32f), prototypeDialogScrimFallback(scheme))
      assertEquals(scheme.surfaceVariant, prototypePlaceholderColor(scheme))
      assertEquals(scheme.onSurfaceVariant, prototypePlaceholderContentColor(scheme))
    }
  }

  private val roleNames =
    PrototypeSpecThemeColors.serializer().descriptor.let { d ->
      (0 until d.elementsCount).map(d::getElementName) - setOf("seed", "source", "light", "dark")
    }

  @Test
  fun `every role override replaces exactly the role it names`() {
    assertEquals(36, roleNames.size)
    val base = lightColorScheme()
    roleNames.forEach { role ->
      val colors = Json.decodeFromString<PrototypeSpecThemeColors>("""{"$role":"#010203"}""")
      val scheme = base.withRoleOverrides(colors)
      assertEquals(role, Color(0xFF010203), prototypeColorRole(scheme, role))
      roleNames
        .filter { it != role }
        .forEach {
          assertEquals(role, prototypeColorRole(base, it), prototypeColorRole(scheme, it))
        }
    }
  }

  @Test
  fun `role overrides apply over a seed scheme and keep the rest of it`() {
    val root = model(PrototypeSpacerNode()).root
    val theme =
      prototypeThemeSpec(
        root,
        false,
        PrototypeSpecTheme(
          mode = "light",
          colors = PrototypeSpecThemeColors(seed = "#6750A4", primary = "#FF0000"),
        ),
      )
    val scheme = prototypeColorScheme(theme)
    val seeded = prototypeSeedColorScheme(Color(0xFF6750A4), false)
    assertEquals(Color(0xFFFF0000), scheme.primary)
    assertEquals(seeded.secondary, scheme.secondary)
    assertEquals(seeded.surface, scheme.surface)
  }

  @Test
  fun `role overrides apply over the device scheme too`() {
    val theme =
      prototypeThemeSpec(
        model(PrototypeSpacerNode()).root,
        false,
        PrototypeSpecTheme(colors = PrototypeSpecThemeColors(source = "device", error = "#00FF00")),
      )
    val dynamic = lightColorScheme(primary = Color(0xFF123456))
    val scheme = prototypeColorScheme(theme, dynamic)
    assertEquals(Color(0xFF123456), scheme.primary)
    assertEquals(Color(0xFF00FF00), scheme.error)
  }

  @Test
  fun `with no mode a dark background override selects dark for content and host chrome`() {
    val lightAuthored = model(PrototypeBoxNode(style = styled("#FFFFFF"), children = emptyList()))
    val explicit =
      PrototypeSpecTheme(
        colors = PrototypeSpecThemeColors(background = "#101010", primary = "#FF0000"),
      )
    val theme = prototypeThemeSpec(lightAuthored.root, false, explicit)
    assertTrue(theme.dark)
    assertNull(theme.surface) // the light authored background must not paint a dark scheme
    assertEquals(Color(0xFF101010), prototypeColorScheme(theme).background)
    assertEquals(darkColorScheme().onSurface, prototypeColorScheme(theme).onSurface)
    assertEquals(true, prototypeHostDark(lightAuthored.copy(theme = explicit)))
  }

  @Test
  fun `an explicit mode still wins over a background override`() {
    val explicit =
      PrototypeSpecTheme(mode = "light", colors = PrototypeSpecThemeColors(surface = "#101010"))
    val root = model(PrototypeSpacerNode())
    assertFalse(prototypeThemeSpec(root.root, true, explicit).dark)
    assertEquals(false, prototypeHostDark(root.copy(theme = explicit)))
  }
}
