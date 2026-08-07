package dev.jasonpearson.automobile.design.system.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.FontFamily
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Pins that every type role uses the branded (hand-drawn Shantell Sans) family rather than the
 * platform default (AC2). Does not load the font file — that is lazy — so this stays a fast host
 * test.
 */
class PlaygroundTypographyTest {

  private val roles: List<Pair<String, androidx.compose.ui.text.TextStyle>> =
    AutoMobileTypography.let { t ->
      listOf(
        "displayLarge" to t.displayLarge,
        "displayMedium" to t.displayMedium,
        "displaySmall" to t.displaySmall,
        "headlineLarge" to t.headlineLarge,
        "headlineMedium" to t.headlineMedium,
        "headlineSmall" to t.headlineSmall,
        "titleLarge" to t.titleLarge,
        "titleMedium" to t.titleMedium,
        "titleSmall" to t.titleSmall,
        "bodyLarge" to t.bodyLarge,
        "bodyMedium" to t.bodyMedium,
        "bodySmall" to t.bodySmall,
        "labelLarge" to t.labelLarge,
        "labelMedium" to t.labelMedium,
        "labelSmall" to t.labelSmall,
      )
    }

  @Test
  fun everyTypeRole_usesBrandedFontFamily() {
    assertNotEquals("AutoMobileTypography should not be empty", Typography(), AutoMobileTypography)
    roles.forEach { (name, style) ->
      assertNotEquals(
        "$name must use the branded font family, not FontFamily.Default",
        FontFamily.Default,
        style.fontFamily,
      )
    }
  }
}
