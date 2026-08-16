package dev.jasonpearson.automobile.desktop

import java.awt.Color
import java.awt.image.BufferedImage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Covers the pure tray-icon helpers: appearance parsing, foreground color selection, and the truck
 * raster. All headless-safe and well under 100ms; the [Tray] composable and the live `defaults`
 * probe (environment-dependent) are intentionally not exercised here.
 */
class SystemTrayTest {

  @Test
  fun `interpretAppleInterfaceStyle treats only Dark as dark`() {
    assertTrue(interpretAppleInterfaceStyle("Dark"))
    assertTrue(interpretAppleInterfaceStyle("Dark\n"))
    assertTrue(interpretAppleInterfaceStyle("  dark  "))
  }

  @Test
  fun `interpretAppleInterfaceStyle treats light-mode output as light`() {
    // Light mode: the key is absent and `defaults` prints an error to (merged) stdout.
    assertFalse(interpretAppleInterfaceStyle(""))
    assertFalse(interpretAppleInterfaceStyle("Light"))
    assertFalse(
      interpretAppleInterfaceStyle(
        "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist"
      )
    )
  }

  @Test
  fun `trayForegroundColor is light on dark menu bars and dark on light menu bars`() {
    val onDark = trayForegroundColor(darkMenuBar = true, connected = true)
    val onLight = trayForegroundColor(darkMenuBar = false, connected = true)
    assertTrue(onDark.red > 200, "icon should be light on a dark menu bar")
    assertTrue(onLight.red < 80, "icon should be dark on a light menu bar")
  }

  @Test
  fun `trayForegroundColor dims when disconnected and is opaque when connected`() {
    assertEquals(255, trayForegroundColor(darkMenuBar = true, connected = true).alpha)
    assertTrue(
      trayForegroundColor(darkMenuBar = true, connected = false).alpha < 255,
      "disconnected truck should be dimmed",
    )
  }

  @Test
  fun `the AutoMobile truck mask is bundled on the classpath`() {
    // The menu-bar icon is tinted from this mask; without it the tray falls back to a plain dot.
    assertNotNull(
      loadBundledImage(TRAY_TRUCK_RESOURCE),
      "the tray truck mask must be bundled on the runtime classpath",
    )
  }

  @Test
  fun `tintTrayTruck produces a square image the size requested`() {
    val image = tintTrayTruck(solidMask(20, 10), TRAY_ICON_SIZE, trayForegroundColor(true, true))
    assertEquals(TRAY_ICON_SIZE, image.width)
    assertEquals(TRAY_ICON_SIZE, image.height)
  }

  @Test
  fun `tintTrayTruck paints the truck in the foreground color on transparent corners`() {
    val fg = trayForegroundColor(darkMenuBar = true, connected = true)
    val image = tintTrayTruck(solidMask(20, 10), TRAY_ICON_SIZE, fg)

    // The mask covers the centre, tinted to fg and fully opaque when connected.
    val center = image.getRGB(TRAY_ICON_SIZE / 2, TRAY_ICON_SIZE / 2)
    assertEquals(255, alphaOf(center), "the truck should be fully painted at the centre")
    assertEquals(fg.rgb and 0xFFFFFF, center and 0xFFFFFF, "the truck should be tinted to fg")

    // Corners fall in the margin and must stay transparent (a template icon, not a filled tile).
    assertEquals(0, alphaOf(image.getRGB(0, 0)), "top-left corner must be transparent")
    assertEquals(
      0,
      alphaOf(image.getRGB(TRAY_ICON_SIZE - 1, TRAY_ICON_SIZE - 1)),
      "bottom-right corner must be transparent",
    )
  }

  @Test
  fun `tintTrayTruck carries the foreground alpha when disconnected`() {
    val fg = trayForegroundColor(darkMenuBar = true, connected = false)
    val image = tintTrayTruck(solidMask(20, 10), TRAY_ICON_SIZE, fg)
    val center = image.getRGB(TRAY_ICON_SIZE / 2, TRAY_ICON_SIZE / 2)
    assertEquals(fg.alpha, alphaOf(center), "disconnected truck should carry the dimmed alpha")
  }

  /** An opaque black rectangle standing in for the truck alpha stencil. */
  private fun solidMask(w: Int, h: Int): BufferedImage {
    val mask = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
    val g = mask.createGraphics()
    g.color = Color.BLACK
    g.fillRect(0, 0, w, h)
    g.dispose()
    return mask
  }

  private fun alphaOf(argb: Int): Int = (argb ushr 24) and 0xFF
}
