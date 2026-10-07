package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.graphics.Color
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

  @Test
  fun `host dismiss colours are translucent and contrast with the scheme`() {
    val dark = overlayDismissColors(true)
    val light = overlayDismissColors(false)
    assertTrue(dark.background.alpha < 1f && light.background.alpha < 1f)
    assertNotEquals(dark.content, light.content)
  }
}
