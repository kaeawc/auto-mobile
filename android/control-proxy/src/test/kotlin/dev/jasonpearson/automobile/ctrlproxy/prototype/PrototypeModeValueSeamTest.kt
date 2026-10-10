package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The per-mode spec forms (#11218) decode and reach the renderer through one seam that still draws
 * the light value; mode-aware resolution is #11219.
 */
class PrototypeModeValueSeamTest {
  private val pair = PrototypeModeValue.Modes("#112233", "#445566")

  @Test
  fun `the seam returns a single value unchanged and the light side of a pair`() {
    assertEquals("surface", prototypeModeValue(PrototypeModeValue.Single("surface")))
    assertEquals("#112233", prototypeModeValue(pair))
  }

  @Test
  fun `style colour pairs map to their light hex and a light role stays unresolved`() {
    val style =
      mapPrototypeStyle(
        PrototypeStyle(
          background = pair,
          color = PrototypeModeValue.Modes("onSurface", "#FFFFFF"),
          shadowColor = pair,
          border = PrototypeBorder(1.0, pair),
        ),
      )
    assertEquals(Color(0xff112233), style.background)
    assertEquals(Color(0xff112233), style.shadowColor)
    assertEquals(Color(0xff112233), style.borderColor)
    assertEquals(Color.Unspecified, style.color)
  }

  @Test
  fun `a placement scrim pair maps to its light hex and a role scrim to none`() {
    assertEquals(
      PrototypePlacement.Fullscreen(Color(0xff112233)),
      mapPrototypePlacement(PrototypeFullscreenPlacement(pair)),
    )
    assertEquals(
      PrototypePlacement.Fullscreen(null),
      mapPrototypePlacement(PrototypeFullscreenPlacement("scrim")),
    )
  }

  @Test
  fun `gradient stops take the light hex and leave a role stop transparent`() {
    val (colors, positions) =
      prototypeGradientStops(
        listOf(
          PrototypeGradientStop(pair),
          PrototypeGradientStop("primary"),
          PrototypeGradientStop("#80FFFFFF"),
        ),
      )
    assertEquals(listOf(Color(0xff112233), Color.Transparent, Color(0x80FFFFFF)), colors)
    assertNull(positions)
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
}
