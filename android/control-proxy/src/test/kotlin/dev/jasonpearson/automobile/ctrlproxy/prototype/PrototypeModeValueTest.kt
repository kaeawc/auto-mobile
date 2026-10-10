package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The per-mode spec forms (#11218) resolve against the prototype's resolved light or dark mode in
 * every slot that takes one (#11219): style colours, gradient stops, both scrims, image assets and
 * the `theme.colors.light` / `theme.colors.dark` role maps.
 */
class PrototypeModeValueTest {
  private val lightHex = Color(0xff112233)
  private val darkHex = Color(0xff445566)
  private val lightPrimary = Color(0xff00aa00)
  private val darkPrimary = Color(0xff00ff00)
  private val hexPair = PrototypeModeValue.Modes("#112233", "#445566")
  private val rolePair = PrototypeModeValue.Modes("primary", "outline")
  private val mixedPair = PrototypeModeValue.Modes("primary", "#445566")

  private val light =
    PrototypePalette(lightColorScheme(primary = lightPrimary, outline = Color.Red), dark = false)
  private val dark =
    PrototypePalette(darkColorScheme(primary = darkPrimary, outline = Color.Blue), dark = true)

  private fun model(root: PrototypeNode, theme: PrototypeSpecTheme? = null) =
    mapPrototypeSpec(
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = root,
        theme = theme,
      ),
    )

  private fun box(background: PrototypeModeValue?, vararg children: PrototypeNode) =
    PrototypeBoxNode(
      style =
        PrototypeStyle(
          width = PrototypeDimension.Fill,
          height = PrototypeDimension.Fill,
          background = background,
        ),
      children = children.toList(),
    )

  @Test
  fun `a single value serves both modes and a pair gives the side for the mode`() {
    val single = PrototypeModeValue.Single("surface")
    assertEquals("surface", prototypeModeValue(single, dark = false))
    assertEquals("surface", prototypeModeValue(single, dark = true))
    assertEquals("#112233", prototypeModeValue(hexPair, dark = false))
    assertEquals("#445566", prototypeModeValue(hexPair, dark = true))
  }

  @Test
  fun `a colour slot resolves hex and role pairs for each mode`() {
    assertEquals(lightHex, prototypeResolveColor(light, null, hexPair))
    assertEquals(darkHex, prototypeResolveColor(dark, null, hexPair))
    assertEquals(lightPrimary, prototypeResolveColor(light, null, rolePair))
    assertEquals(Color.Blue, prototypeResolveColor(dark, null, rolePair))
    assertEquals(lightPrimary, prototypeResolveColor(light, null, mixedPair))
    assertEquals(darkHex, prototypeResolveColor(dark, null, mixedPair))
  }

  @Test
  fun `a single hex or role resolves the same way in both modes`() {
    val hex = PrototypeModeValue.Single("#80FF0000")
    val role = PrototypeModeValue.Single("primary")
    assertEquals(Color(0x80FF0000), prototypeResolveColor(light, null, hex))
    assertEquals(Color(0x80FF0000), prototypeResolveColor(dark, null, hex))
    assertEquals(lightPrimary, prototypeResolveColor(light, null, role))
    assertEquals(darkPrimary, prototypeResolveColor(dark, null, role))
  }

  @Test
  fun `the parsed literal is reused only for a single hex value`() {
    val hex = PrototypeModeValue.Single("#112233")
    assertEquals(Color.Magenta, prototypeResolveColor(light, Color.Magenta, hex))
    // An unset `style.color` maps to Unspecified, which must not stand in for a hex value.
    assertEquals(lightHex, prototypeResolveColor(light, Color.Unspecified, hex))
    assertEquals(darkHex, prototypeResolveColor(dark, Color.Magenta, hexPair))
    assertEquals(Color.Magenta, prototypeResolveColor(light, Color.Magenta, null))
    assertNull(prototypeResolveColor(light, null, null))
    // An unknown role cannot pass validation; it keeps the literal rather than throwing.
    assertNull(prototypeResolveColor(light, null, PrototypeModeValue.Single("onPurple")))
  }

  @Test
  fun `style colour pairs map to no literal and resolve per mode in every style slot`() {
    val source =
      PrototypeStyle(
        background = hexPair,
        color = mixedPair,
        shadowColor = rolePair,
        border = PrototypeBorder(1.0, hexPair),
      )
    val style = mapPrototypeStyle(source)
    assertNull(style.background)
    assertNull(style.shadowColor)
    assertNull(style.borderColor)
    assertEquals(Color.Unspecified, style.color)

    assertEquals(lightHex, prototypeResolveColor(light, style.background, source.background))
    assertEquals(darkHex, prototypeResolveColor(dark, style.background, source.background))
    assertEquals(lightPrimary, prototypeResolveColor(light, style.color, source.color))
    assertEquals(darkHex, prototypeResolveColor(dark, style.color, source.color))
    assertEquals(lightPrimary, prototypeResolveColor(light, style.shadowColor, source.shadowColor))
    assertEquals(Color.Blue, prototypeResolveColor(dark, style.shadowColor, source.shadowColor))
    val border = source.border?.color
    assertEquals(lightHex, prototypeResolveColor(light, style.borderColor, border))
    assertEquals(darkHex, prototypeResolveColor(dark, style.borderColor, border))
  }

  @Test
  fun `a styleWhen pair replaces the base colour and resolves per mode`() {
    val resolved =
      resolvePrototypeStyle(
        PrototypeStyle(background = PrototypeModeValue.Single("#000000")),
        listOf(
          PrototypeStyleWhen(
            PrototypeCondition("open", PrototypeScalar.BooleanValue(true)),
            PrototypeStyle(background = rolePair),
          ),
        ),
        mapOf("open" to PrototypeScalar.BooleanValue(true)),
      )
    val style = mapPrototypeStyle(resolved)
    assertEquals(lightPrimary, prototypeResolveColor(light, style.background, resolved.background))
    assertEquals(Color.Blue, prototypeResolveColor(dark, style.background, resolved.background))
  }

  @Test
  fun `gradient stops resolve roles and pairs for each mode`() {
    val stops =
      listOf(
        PrototypeGradientStop("primary"),
        PrototypeGradientStop(hexPair),
        PrototypeGradientStop(mixedPair),
        PrototypeGradientStop(rolePair),
        PrototypeGradientStop("#80FFFFFF"),
      )
    val (lightColors, positions) = prototypeGradientStops(stops, light)
    assertEquals(
      listOf(lightPrimary, lightHex, lightPrimary, lightPrimary, Color(0x80FFFFFF)),
      lightColors,
    )
    assertNull(positions)
    assertEquals(
      listOf(darkPrimary, darkHex, darkHex, Color.Blue, Color(0x80FFFFFF)),
      prototypeGradientStops(stops, dark).first,
    )
  }

  private val defaultScrimAlpha = 0.4f

  private fun fullscreen(scrim: PrototypeModeValue?) =
    mapPrototypePlacement(PrototypeFullscreenPlacement(scrim)) as PrototypePlacement.Fullscreen

  private fun sheetScrim(scrim: PrototypeModeValue?) =
    PrototypeBottomSheetNode(
        child = PrototypeSpacerNode(),
        openWhen = PrototypeSheetCondition("open", true),
        detents = emptyList(),
        scrim = scrim,
      )
      .scrim

  /** Both scrim positions resolve [scrim] through the one rule; returns light then dark. */
  private fun scrims(scrim: PrototypeModeValue?): List<Pair<Color?, Color?>> {
    val window = fullscreen(scrim)
    val sheet = sheetScrim(scrim)
    return listOf(
      prototypeResolveScrim(light, window.scrim, window.scrimSpec) to
        prototypeResolveScrim(dark, window.scrim, window.scrimSpec),
      prototypeResolveScrim(light, null, sheet) to prototypeResolveScrim(dark, null, sheet),
    )
  }

  @Test
  fun `a fullscreen scrim keeps its authored slot beside the single hex literal`() {
    assertEquals(
      PrototypePlacement.Fullscreen(Color(0x66000000), PrototypeModeValue.Single("#66000000")),
      mapPrototypePlacement(PrototypeFullscreenPlacement("#66000000")),
    )
    assertNull(fullscreen(PrototypeModeValue.Single("scrim")).scrim)
    assertNull(fullscreen(hexPair).scrim)
  }

  @Test
  fun `the default scrim opacity is the sheet's unauthored default`() {
    assertEquals(defaultScrimAlpha, PROTOTYPE_SHEET_SCRIM_ALPHA)
    assertEquals(
      prototypeSheetScrimFallback(light),
      prototypeResolveScrim(light, null, PrototypeModeValue.Single("scrim")),
    )
  }

  @Test
  fun `the scrim role draws at the default scrim opacity in each scrim position and mode`() {
    scrims(PrototypeModeValue.Single("scrim")).forEach { (lightScrim, darkScrim) ->
      assertEquals(light.scheme.scrim.copy(alpha = defaultScrimAlpha), lightScrim)
      assertEquals(dark.scheme.scrim.copy(alpha = defaultScrimAlpha), darkScrim)
    }
  }

  @Test
  fun `another role used as a scrim keeps its scheme colour unchanged`() {
    scrims(PrototypeModeValue.Single("primary")).forEach { (lightScrim, darkScrim) ->
      assertEquals(lightPrimary, lightScrim)
      assertEquals(darkPrimary, darkScrim)
    }
    scrims(rolePair).forEach { (lightScrim, darkScrim) ->
      assertEquals(lightPrimary, lightScrim)
      assertEquals(Color.Blue, darkScrim)
    }
  }

  @Test
  fun `a hex scrim keeps exactly its authored alpha`() {
    scrims(PrototypeModeValue.Single("#52000000")).forEach { (lightScrim, darkScrim) ->
      assertEquals(Color(0x52000000), lightScrim)
      assertEquals(Color(0x52000000), darkScrim)
    }
    scrims(PrototypeModeValue.Modes("#52000000", "#99FFFFFF")).forEach { (lightScrim, darkScrim) ->
      assertEquals(Color(0x52000000), lightScrim)
      assertEquals(Color(0x99FFFFFF), darkScrim)
    }
  }

  @Test
  fun `a scrim pair mixing a role and a hex applies the rule to the side for the mode`() {
    scrims(PrototypeModeValue.Modes("#66000000", "scrim")).forEach { (lightScrim, darkScrim) ->
      assertEquals(Color(0x66000000), lightScrim)
      assertEquals(dark.scheme.scrim.copy(alpha = defaultScrimAlpha), darkScrim)
    }
    scrims(PrototypeModeValue.Modes("scrim", "primary")).forEach { (lightScrim, darkScrim) ->
      assertEquals(light.scheme.scrim.copy(alpha = defaultScrimAlpha), lightScrim)
      assertEquals(darkPrimary, darkScrim)
    }
  }

  @Test
  fun `an unauthored scrim resolves to none and the scrim role keeps its alpha only in scrims`() {
    scrims(null).forEach { (lightScrim, darkScrim) ->
      assertNull(lightScrim)
      assertNull(darkScrim)
    }
    // As a style colour or gradient stop the role is the scheme's opaque colour.
    val role = PrototypeModeValue.Single("scrim")
    assertEquals(light.scheme.scrim, prototypeResolveColor(light, null, role))
    assertEquals(
      listOf(dark.scheme.scrim),
      prototypeGradientStops(listOf(PrototypeGradientStop("scrim")), dark).first,
    )
  }

  @Test
  fun `an image asset pair draws the asset for the mode`() {
    val image = PrototypeImageNode(asset = PrototypeModeValue.Modes("logo-light", "logo-dark"))
    assertEquals("logo-light", prototypeModeValue(image.asset, dark = false))
    assertEquals("logo-dark", prototypeModeValue(image.asset, dark = true))
    val item = PrototypeItem("Home", image = PrototypeModeValue.Modes("home", "home-dark"))
    assertEquals("home", item.image?.let { prototypeModeValue(it, dark = false) })
    assertEquals("home-dark", item.image?.let { prototypeModeValue(it, dark = true) })
  }

  @Test
  fun `asset references list both ids of a pair once each`() {
    val root =
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeImageNode(asset = PrototypeModeValue.Modes("logo-light", "logo-dark")),
            PrototypeImageNode(asset = PrototypeModeValue.Modes("photo", "photo")),
            PrototypeTabBarNode(
              items =
                listOf(
                  PrototypeItem("Home", image = PrototypeModeValue.Modes("home", "logo-dark")),
                  PrototypeItem("Search", image = "search"),
                ),
              stateKey = "tab",
            ),
          ),
      )
    assertEquals(
      listOf("logo-light", "logo-dark", "photo", "home", "search"),
      prototypeAssetReferences(root),
    )
  }

  private val modeMaps =
    PrototypeSpecThemeColors(
      primary = "#B3261E",
      secondary = "#010101",
      light = mapOf("surface" to "#FFFBFE", "primary" to "#0000FF"),
      dark = mapOf("surface" to "#1C1B1F", "onSurface" to "#E6E1E5"),
    )

  private fun scheme(dark: Boolean, colors: PrototypeSpecThemeColors = modeMaps) =
    prototypeColorScheme(
      prototypeThemeSpec(
        model(PrototypeSpacerNode()).root,
        dark,
        PrototypeSpecTheme(colors = colors),
      ),
    )

  @Test
  fun `the map for the resolved mode applies after the flat role overrides`() {
    val lightScheme = scheme(dark = false)
    assertEquals(Color(0xFFFFFBFE), lightScheme.surface)
    assertEquals("the light map wins over the flat role", Color(0xFF0000FF), lightScheme.primary)
    assertEquals(Color(0xFF010101), lightScheme.secondary)
    assertEquals("the dark map is not applied", lightColorScheme().onSurface, lightScheme.onSurface)

    val darkScheme = scheme(dark = true)
    assertEquals(Color(0xFF1C1B1F), darkScheme.surface)
    assertEquals(Color(0xFFE6E1E5), darkScheme.onSurface)
    assertEquals(
      "the flat role serves a mode whose map omits it",
      Color(0xFFB3261E),
      darkScheme.primary,
    )
    assertEquals(Color(0xFF010101), darkScheme.secondary)
  }

  @Test
  fun `mode maps apply over a seed scheme and over the device scheme`() {
    val root = model(PrototypeSpacerNode()).root
    val maps = mapOf("primary" to "#0000FF")
    val seeded =
      prototypeColorScheme(
        prototypeThemeSpec(
          root,
          true,
          PrototypeSpecTheme(colors = PrototypeSpecThemeColors(seed = "#6750A4", dark = maps)),
        ),
      )
    assertEquals(Color(0xFF0000FF), seeded.primary)
    assertEquals(prototypeSeedColorScheme(Color(0xFF6750A4), true).secondary, seeded.secondary)

    val deviceTheme =
      prototypeThemeSpec(
        root,
        false,
        PrototypeSpecTheme(colors = PrototypeSpecThemeColors(source = "device", light = maps)),
      )
    val dynamic = lightColorScheme(error = Color(0xFF123456))
    val device = prototypeColorScheme(deviceTheme, dynamic)
    assertEquals(Color(0xFF0000FF), device.primary)
    assertEquals(Color(0xFF123456), device.error)
  }

  @Test
  fun `every role in a mode map replaces exactly the role it names`() {
    val roleNames =
      PrototypeSpecThemeColors.serializer().descriptor.let { d ->
        (0 until d.elementsCount).map(d::getElementName) - setOf("seed", "source", "light", "dark")
      }
    val base = darkColorScheme()
    roleNames.forEach { role ->
      val mapped = base.withRoleMap(mapOf(role to "#010203"))
      assertEquals(role, Color(0xFF010203), prototypeColorRole(mapped, role))
      roleNames
        .filter { it != role }
        .forEach {
          assertEquals(role, prototypeColorRole(base, it), prototypeColorRole(mapped, it))
        }
    }
  }

  @Test
  fun `a role name in a colour slot takes the mode map's override`() {
    val role = PrototypeModeValue.Single("surface")
    val pair = PrototypeModeValue.Modes("surface", "onSurface")
    val lightPalette = PrototypePalette(scheme(dark = false), dark = false)
    val darkPalette = PrototypePalette(scheme(dark = true), dark = true)
    assertEquals(Color(0xFFFFFBFE), prototypeResolveColor(lightPalette, null, role))
    assertEquals(Color(0xFF1C1B1F), prototypeResolveColor(darkPalette, null, role))
    assertEquals(Color(0xFFFFFBFE), prototypeResolveColor(lightPalette, null, pair))
    assertEquals(Color(0xFFE6E1E5), prototypeResolveColor(darkPalette, null, pair))
  }

  @Test
  fun `mode maps never decide the mode and only the flat surface override does`() {
    val root = model(PrototypeSpacerNode()).root
    val maps =
      PrototypeSpecThemeColors(
        light = mapOf("background" to "#000000", "surface" to "#000000"),
        dark = mapOf("background" to "#FFFFFF", "surface" to "#FFFFFF"),
      )
    assertFalse(prototypeThemeSpec(root, false, PrototypeSpecTheme(colors = maps)).dark)
    assertTrue(prototypeThemeSpec(root, true, PrototypeSpecTheme(colors = maps)).dark)
    assertNull(prototypeHostDark(model(PrototypeSpacerNode(), PrototypeSpecTheme(colors = maps))))
    val flat = maps.copy(surface = "#101010")
    assertTrue(prototypeThemeSpec(root, false, PrototypeSpecTheme(colors = flat)).dark)
  }

  @Test
  fun `an explicit mode picks the pair side whatever the device setting`() {
    val root = model(box(hexPair)).root
    assertTrue(prototypeThemeSpec(root, false, PrototypeSpecTheme(mode = "dark")).dark)
    assertFalse(prototypeThemeSpec(root, true, PrototypeSpecTheme(mode = "light")).dark)
    assertTrue(prototypeThemeSpec(root, true, PrototypeSpecTheme(mode = "system")).dark)
  }

  @Test
  fun `a background pair does not infer the mode and the leading chain is searched past it`() {
    // Dark on the light side: were the light value used for inference, this would read as dark.
    val inverted = PrototypeModeValue.Modes("#000000", "#FFFFFF")
    val pairOnly = model(box(inverted))
    assertNull(prototypeAuthoredTheme(pairOnly.root))
    assertFalse(prototypeThemeSpec(pairOnly.root, false).dark)
    assertTrue(prototypeThemeSpec(pairOnly.root, true).dark)
    assertNull(prototypeHostDark(pairOnly))

    val hexChild = model(box(inverted, box(PrototypeModeValue.Single("#101010"))))
    assertEquals(true, prototypeAuthoredTheme(hexChild.root)?.dark)
    assertTrue(prototypeThemeSpec(hexChild.root, false).dark)
  }

  private fun opaque(
    root: PrototypeNode,
    scrim: PrototypeModeValue? = null,
    theme: PrototypeSpecTheme? = null,
  ) =
    prototypeWindowMetadata(
        mapPrototypeSpec(
          PrototypeSpec(
            "panel",
            PrototypeWindow(PrototypeFullscreenPlacement(scrim)),
            root = root,
            theme = theme,
          ),
        ),
        dismissBarOpaque = true,
      )
      .opaque

  @Test
  fun `window metadata counts a root background as it is drawn in every reachable mode`() {
    assertTrue(opaque(box(hexPair)))
    assertFalse(opaque(box(PrototypeModeValue.Modes("#FFFFFF", "#80000000"))))
    // An explicit mode makes only one side reachable.
    val lightOnly = PrototypeSpecTheme(mode = "light")
    assertTrue(opaque(box(PrototypeModeValue.Modes("#FFFFFF", "#80000000")), theme = lightOnly))
    assertTrue(opaque(box(PrototypeModeValue.Single("surface"))))
    assertTrue(opaque(box(rolePair)))
    val translucentSurface =
      PrototypeSpecTheme(colors = PrototypeSpecThemeColors(dark = mapOf("surface" to "#80000000")))
    assertFalse(opaque(box(PrototypeModeValue.Single("surface")), theme = translucentSurface))
    assertTrue(
      opaque(
        box(PrototypeModeValue.Single("surface")),
        theme = translucentSurface.copy(mode = "light"),
      ),
    )
  }

  @Test
  fun `window metadata counts a scrim as it is drawn in every reachable mode`() {
    val clear = PrototypeSpacerNode()
    assertTrue(opaque(clear, scrim = hexPair))
    assertTrue(opaque(clear, scrim = PrototypeModeValue.Single("#FF000000")))
    assertFalse(opaque(clear, scrim = PrototypeModeValue.Single("#66000000")))
    assertFalse(opaque(clear, scrim = null))
    // The scrim role is drawn at the default scrim opacity, so it never hides the app.
    assertFalse(opaque(clear, scrim = PrototypeModeValue.Single("scrim")))
    assertFalse(opaque(clear, scrim = PrototypeModeValue.Modes("#FF000000", "scrim")))
    assertTrue(
      opaque(
        clear,
        scrim = PrototypeModeValue.Modes("#FF000000", "scrim"),
        theme = PrototypeSpecTheme(mode = "light"),
      ),
    )
    // Another role is drawn unchanged: opaque unless the theme overrides it with alpha.
    assertTrue(opaque(clear, scrim = PrototypeModeValue.Single("surface")))
    assertTrue(opaque(clear, scrim = PrototypeModeValue.Modes("surface", "#FF101010")))
    assertFalse(opaque(clear, scrim = PrototypeModeValue.Modes("surface", "#80101010")))
    assertFalse(
      opaque(
        clear,
        scrim = PrototypeModeValue.Single("surface"),
        theme = PrototypeSpecTheme(colors = PrototypeSpecThemeColors(surface = "#80FFFFFF")),
      ),
    )
  }
}
