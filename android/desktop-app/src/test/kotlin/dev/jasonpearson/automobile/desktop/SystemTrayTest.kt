package dev.jasonpearson.automobile.desktop

import java.awt.Color
import java.awt.image.BufferedImage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Covers the pure tray-icon helpers: appearance parsing, foreground color selection, and the truck
 * raster. All headless-safe and well under 100ms; the [Tray] composable and the live `defaults`
 * probe (environment-dependent) are intentionally not exercised here.
 */
class SystemTrayTest {

  @Test
  fun `macOS dark mode (exit 0, Dark) draws a light icon`() {
    assertTrue(detectDarkMenuBar("Mac OS X", probeReturning(AppearanceProbeResult(0, "Dark\n"))))
  }

  @Test
  fun `macOS light mode (absent key) draws a dark icon`() {
    val absent = AppearanceProbeResult(1, "... (..., AppleInterfaceStyle) does not exist")
    assertFalse(detectDarkMenuBar("Mac OS X", probeReturning(absent)))
  }

  @Test
  fun `macOS unexpected probe failure falls back to dark instead of light`() {
    // A non-zero exit that is NOT the absent-key case must not be read as light.
    assertTrue(detectDarkMenuBar("Mac OS X", probeReturning(AppearanceProbeResult(1, "boom"))))
    assertTrue(detectDarkMenuBar("Mac OS X", probeReturning(null)))
  }

  @Test
  fun `Windows light taskbar draws a dark icon`() {
    val light = AppearanceProbeResult(0, "    SystemUsesLightTheme    REG_DWORD    0x1")
    assertFalse(detectDarkMenuBar("Windows 11", probeReturning(light)))
  }

  @Test
  fun `Windows dark taskbar and probe failures default to dark`() {
    val dark = AppearanceProbeResult(0, "    SystemUsesLightTheme    REG_DWORD    0x0")
    assertTrue(detectDarkMenuBar("Windows 11", probeReturning(dark)))
    assertTrue(detectDarkMenuBar("Windows 11", probeReturning(AppearanceProbeResult(1, "ERROR"))))
  }

  @Test
  fun `Linux falls back to dark without probing`() {
    assertTrue(detectDarkMenuBar("Linux") { fail("Linux must not shell out for appearance") })
  }

  private fun probeReturning(result: AppearanceProbeResult?) = AppearanceProbe { result }

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
  fun `the real truck mask stays legible at a small tray size`() {
    // Regression for a thin-outline mask that all but vanished once downsized to a ~16px slot.
    val mask = requireNotNull(loadBundledImage(TRAY_TRUCK_RESOURCE))
    val fg = trayForegroundColor(darkMenuBar = true, connected = false) // dimmed: the worst case
    val image = tintTrayTruck(mask, 16, fg)

    var opaque = 0
    var maxAlpha = 0
    for (index in 0 until 16 * 16) {
      val alpha = alphaOf(image.getRGB(index % 16, index / 16))
      if (alpha > 0) opaque++
      if (alpha > maxAlpha) maxAlpha = alpha
    }
    assertTrue(opaque >= 40, "truck should fill the tray slot; only $opaque/256 px were painted")
    assertTrue(
      maxAlpha >= 110,
      "a solid silhouette should reach full tint; max alpha was $maxAlpha",
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
