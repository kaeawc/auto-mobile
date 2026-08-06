package dev.jasonpearson.automobile.design.system.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the icon-derived Playground palette (AC1). The colours are sampled from
 * `docs/img/playground-launch-icon-concept.png`; changing a value here is a deliberate design
 * decision, not an incidental edit.
 */
class PlaygroundColorTokensTest {

  @Test
  fun lightRoleTokens_matchIconDerivedPalette() {
    assertEquals(Color(0xFFDF3028), PgLightPrimary) // marker red (truck outline)
    assertEquals(Color(0xFFFFFFFF), PgLightOnPrimary)
    assertEquals(Color(0xFF1F6FC2), PgLightSecondary) // swing / sky blue (AA-tuned)
    assertEquals(Color(0xFFFFFFFF), PgLightOnSecondary)
    assertEquals(Color(0xFFFFD23F), PgLightTertiary) // sun yellow
    assertEquals(Color(0xFF3A2E00), PgLightOnTertiary)
    assertEquals(Color(0xFFFFF7EC), PgLightBackground) // warm cream
    assertEquals(Color(0xFF241E18), PgLightOnBackground)
    assertEquals(Color(0xFFFFFFFF), PgLightSurface)
    assertEquals(Color(0xFF241E18), PgLightOnSurface)
    assertEquals(Color(0xFFC1271F), PgLightError)
    assertEquals(Color(0xFFFFFFFF), PgLightOnError)
  }

  @Test
  fun darkRoleTokens_matchIconDerivedPalette() {
    assertEquals(Color(0xFFFF8A7E), PgDarkPrimary)
    assertEquals(Color(0xFF3A0A05), PgDarkOnPrimary)
    assertEquals(Color(0xFF8FC4F5), PgDarkSecondary)
    assertEquals(Color(0xFF0A2A45), PgDarkOnSecondary)
    assertEquals(Color(0xFFFFDD6B), PgDarkTertiary)
    assertEquals(Color(0xFF3A2E00), PgDarkOnTertiary)
    assertEquals(Color(0xFF14110D), PgDarkBackground)
    assertEquals(Color(0xFFF3E9DB), PgDarkOnBackground)
    assertEquals(Color(0xFF241E17), PgDarkSurface)
    assertEquals(Color(0xFFF3E9DB), PgDarkOnSurface)
    assertEquals(Color(0xFFFFB4AB), PgDarkError)
    assertEquals(Color(0xFF690005), PgDarkOnError)
  }

  @Test
  fun playfulAccents_areAvailableForComponentUse() {
    assertEquals(Color(0xFF2F7FD6), PgAccentSkyBlue)
    assertEquals(Color(0xFF57AB46), PgAccentGrassGreen)
    assertEquals(Color(0xFFF2C879), PgAccentSandTan)
    assertEquals(Color(0xFF8E5BD0), PgAccentSlidePurple)
    assertEquals(Color(0xFFFF7A1A), PgAccentConeOrange)
    assertEquals(Color(0xFF282827), PgAccentInk)
  }
}
