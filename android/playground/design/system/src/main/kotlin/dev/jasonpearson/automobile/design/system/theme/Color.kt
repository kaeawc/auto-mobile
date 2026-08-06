package dev.jasonpearson.automobile.design.system.theme

import androidx.compose.ui.graphics.Color

// Design System Color Palette
val AutoMobileBlack = Color(0xFF000000)
val AutoMobileRed =
  Color(0xFFFF0000) // Only for standalone "AutoMobile" word/wordmark, not in sentences
val AutoMobileEggshell = Color(0xFFF8F8FF)
val AutoMobileLalala = Color(0xFF1a1a1a)
val AutoMobileWhite = Color(0xFFFFFFFF)

// Promo video colors
val PromoOrange = Color(0xFFFF3300) // Primary flow elements in presentations and Mermaid diagrams
val PromoBlue =
  Color(0xFF525FE1) // Secondary elements and connections in presentations and Mermaid diagrams

val AutoMobileLightGrey = Color(0xFFBDBDBD)
val AutoMobileDarkGrey = Color(0xFF424242)

// Semantic colors for states
val AutoMobileSuccess = Color(0xFF4CAF50)
val AutoMobileWarning = Color(0xFFFF9800)
val AutoMobileError = Color(0xFFF44336)
val AutoMobileInfo = PromoBlue

// ---------------------------------------------------------------------------
// Playground crayon/marker palette — sampled from the app-icon illustration
// (docs/img/playground-launch-icon-concept.png). Every light/dark role pair
// below is verified against WCAG AA in PlaygroundContrastTest. See
// docs/design-docs/playground-design-system.md for the full spec.
// ---------------------------------------------------------------------------

// Light scheme role tokens
val PgLightPrimary = Color(0xFFDF3028) // marker red — the truck outline
val PgLightOnPrimary = Color(0xFFFFFFFF)
val PgLightSecondary = Color(0xFF1F6FC2) // swing / sky blue (deepened for AA text)
val PgLightOnSecondary = Color(0xFFFFFFFF)
val PgLightTertiary = Color(0xFFFFD23F) // sun yellow
val PgLightOnTertiary = Color(0xFF3A2E00)
val PgLightBackground = Color(0xFFFFF7EC) // warm crayon-paper cream
val PgLightOnBackground = Color(0xFF241E18)
val PgLightSurface = Color(0xFFFFFFFF)
val PgLightOnSurface = Color(0xFF241E18)
val PgLightError = Color(0xFFC1271F)
val PgLightOnError = Color(0xFFFFFFFF)

// Dark scheme role tokens
val PgDarkPrimary = Color(0xFFFF8A7E)
val PgDarkOnPrimary = Color(0xFF3A0A05)
val PgDarkSecondary = Color(0xFF8FC4F5)
val PgDarkOnSecondary = Color(0xFF0A2A45)
val PgDarkTertiary = Color(0xFFFFDD6B)
val PgDarkOnTertiary = Color(0xFF3A2E00)
val PgDarkBackground = Color(0xFF14110D)
val PgDarkOnBackground = Color(0xFFF3E9DB)
val PgDarkSurface = Color(0xFF241E17)
val PgDarkOnSurface = Color(0xFFF3E9DB)
val PgDarkError = Color(0xFFFFB4AB)
val PgDarkOnError = Color(0xFF690005)

// Playful accents from the icon scene, for illustration/component use. These are
// vivid (not AA-guaranteed as text colours) — pair with ink/white for text.
val PgAccentSkyBlue = Color(0xFF2F7FD6)
val PgAccentGrassGreen = Color(0xFF57AB46)
val PgAccentSandTan = Color(0xFFF2C879)
val PgAccentSlidePurple = Color(0xFF8E5BD0)
val PgAccentConeOrange = Color(0xFFFF7A1A)
val PgAccentInk = Color(0xFF282827)
