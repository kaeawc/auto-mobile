package dev.jasonpearson.automobile.design.system.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins WCAG AA contrast (AC1) for every foreground/background role pair the theme relies on,
 * computed directly from the palette tokens so a future palette tweak that breaks legibility fails
 * here rather than in the field.
 */
class PlaygroundContrastTest {

  private fun channel(c: Double): Double =
    if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)

  private fun luminance(color: Color): Double {
    val argb = color.toArgb()
    val r = ((argb shr 16) and 0xFF) / 255.0
    val g = ((argb shr 8) and 0xFF) / 255.0
    val b = (argb and 0xFF) / 255.0
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  private fun contrast(fg: Color, bg: Color): Double {
    val l1 = luminance(fg)
    val l2 = luminance(bg)
    val hi = maxOf(l1, l2)
    val lo = minOf(l1, l2)
    return (hi + 0.05) / (lo + 0.05)
  }

  private fun assertAA(name: String, fg: Color, bg: Color) {
    val ratio = contrast(fg, bg)
    assertTrue("$name contrast $ratio must be >= 4.5 (WCAG AA normal text)", ratio >= 4.5)
  }

  @Test
  fun lightScheme_textRolesMeetAA() {
    assertAA("light onBackground/background", PgLightOnBackground, PgLightBackground)
    assertAA("light onSurface/surface", PgLightOnSurface, PgLightSurface)
    assertAA("light onPrimary/primary", PgLightOnPrimary, PgLightPrimary)
    assertAA("light onSecondary/secondary", PgLightOnSecondary, PgLightSecondary)
    assertAA("light onTertiary/tertiary", PgLightOnTertiary, PgLightTertiary)
    assertAA("light onError/error", PgLightOnError, PgLightError)
  }

  /**
   * Accent roles that consumers legitimately use as foreground *text* (links, status labels) must
   * be readable on the background and surface. tertiary is intentionally excluded — it is a
   * fill-only role (yellow) and must be paired with onTertiary, never used as text.
   */
  @Test
  fun lightAccentRoles_readableAsTextOnBackgroundAndSurface() {
    assertAA("light primary-as-text/background", PgLightPrimary, PgLightBackground)
    assertAA("light primary-as-text/surface", PgLightPrimary, PgLightSurface)
    assertAA("light secondary-as-text/background", PgLightSecondary, PgLightBackground)
    assertAA("light error-as-text/background", PgLightError, PgLightBackground)
  }

  @Test
  fun darkAccentRoles_readableAsTextOnBackgroundAndSurface() {
    assertAA("dark primary-as-text/background", PgDarkPrimary, PgDarkBackground)
    assertAA("dark primary-as-text/surface", PgDarkPrimary, PgDarkSurface)
    assertAA("dark secondary-as-text/background", PgDarkSecondary, PgDarkBackground)
    assertAA("dark error-as-text/background", PgDarkError, PgDarkBackground)
  }

  @Test
  fun darkScheme_textRolesMeetAA() {
    assertAA("dark onBackground/background", PgDarkOnBackground, PgDarkBackground)
    assertAA("dark onSurface/surface", PgDarkOnSurface, PgDarkSurface)
    assertAA("dark onPrimary/primary", PgDarkOnPrimary, PgDarkPrimary)
    assertAA("dark onSecondary/secondary", PgDarkOnSecondary, PgDarkSecondary)
    assertAA("dark onTertiary/tertiary", PgDarkOnTertiary, PgDarkTertiary)
    assertAA("dark onError/error", PgDarkOnError, PgDarkError)
  }
}
