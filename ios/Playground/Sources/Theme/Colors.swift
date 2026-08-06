import SwiftUI

// MARK: - Design System Color Palette

extension Color {
    // Core AutoMobile colors
    static let autoMobileBlack = Color(hex: 0x000000)
    static let autoMobileRed = Color(hex: 0xFF0000) // Only for standalone "AutoMobile" word/wordmark
    static let autoMobileEggshell = Color(hex: 0xF8F8FF)
    static let autoMobileLalala = Color(hex: 0x1A1A1A)
    static let autoMobileWhite = Color(hex: 0xFFFFFF)

    // Promo video colors
    static let promoOrange = Color(hex: 0xFF3300)
    static let promoBlue = Color(hex: 0x525FE1)

    // Greys
    static let autoMobileLightGrey = Color(hex: 0xBDBDBD)
    static let autoMobileDarkGrey = Color(hex: 0x424242)

    // Semantic colors for states
    static let autoMobileSuccess = Color(hex: 0x4CAF50)
    static let autoMobileWarning = Color(hex: 0xFF9800)
    static let autoMobileError = Color(hex: 0xF44336)
    static let autoMobileInfo = Color.promoBlue

    // MARK: - Playground crayon palette (icon-derived, mirrors the Android
    // design-system Pg* tokens). Every light/dark text pair is WCAG-AA verified
    // by PlaygroundContrastTests. Spec: docs/design-docs/playground-design-system.md

    // Light role tokens
    // Marker red from the truck outline (#DF3028), darkened slightly to #D62A22
    // so it also meets AA as foreground text on the light background.
    static let pgLightPrimary = Color(hex: 0xD62A22)
    static let pgLightOnPrimary = Color(hex: 0xFFFFFF)
    static let pgLightSecondary = Color(hex: 0x1F6FC2) // swing / sky blue (AA-tuned)
    static let pgLightOnSecondary = Color(hex: 0xFFFFFF)
    static let pgLightTertiary = Color(hex: 0xFFD23F) // sun yellow
    static let pgLightOnTertiary = Color(hex: 0x3A2E00)
    static let pgLightBackground = Color(hex: 0xFFF7EC) // warm crayon paper
    static let pgLightOnBackground = Color(hex: 0x241E18)
    static let pgLightSurface = Color(hex: 0xFFFFFF)
    static let pgLightOnSurface = Color(hex: 0x241E18)
    static let pgLightError = Color(hex: 0xC1271F)
    static let pgLightOnError = Color(hex: 0xFFFFFF)

    // Dark role tokens
    static let pgDarkPrimary = Color(hex: 0xFF8A7E)
    static let pgDarkOnPrimary = Color(hex: 0x3A0A05)
    static let pgDarkSecondary = Color(hex: 0x8FC4F5)
    static let pgDarkOnSecondary = Color(hex: 0x0A2A45)
    static let pgDarkTertiary = Color(hex: 0xFFDD6B)
    static let pgDarkOnTertiary = Color(hex: 0x3A2E00)
    static let pgDarkBackground = Color(hex: 0x14110D)
    static let pgDarkOnBackground = Color(hex: 0xF3E9DB)
    static let pgDarkSurface = Color(hex: 0x241E17)
    static let pgDarkOnSurface = Color(hex: 0xF3E9DB)
    static let pgDarkError = Color(hex: 0xFFB4AB)
    static let pgDarkOnError = Color(hex: 0x690005)

    // Playful scene accents (illustration/component fills; pair with ink/white
    // for text — not AA-guaranteed as text colours).
    static let pgAccentSkyBlue = Color(hex: 0x2F7FD6)
    static let pgAccentGrassGreen = Color(hex: 0x57AB46)
    static let pgAccentSandTan = Color(hex: 0xF2C879)
    static let pgAccentSlidePurple = Color(hex: 0x8E5BD0)
    static let pgAccentConeOrange = Color(hex: 0xFF7A1A)
    static let pgAccentInk = Color(hex: 0x282827)
}

// MARK: - Color Hex Initializer

extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: alpha
        )
    }
}
