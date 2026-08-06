import SwiftUI

// MARK: - Playground typography

/// Shantell Sans (SIL OFL) — the hand-drawn marker family behind every type role,
/// mirroring the Android design system's scale. The font is a variable TTF anchored
/// on its default instance; `.weight()` drives the `wght` axis on iOS.
/// Font + licence: `Sources/Resources/Fonts/ShantellSans.ttf`, `licenses/ShantellSans-OFL.txt`.
enum PlaygroundFont {
    /// PostScript name of the vendored variable font's default instance.
    static let baseName = "ShantellSans-Light"

    static func shantell(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        Font.custom(baseName, size: size).weight(weight)
    }
}

/// Type roles mirroring the Android `AutoMobileTypography` scale (Material sizes,
/// Shantell Sans family).
struct PlaygroundTypography {
    let displayLarge = PlaygroundFont.shantell(57, .regular)
    let displayMedium = PlaygroundFont.shantell(45, .regular)
    let displaySmall = PlaygroundFont.shantell(36, .regular)
    let headlineLarge = PlaygroundFont.shantell(32, .semibold)
    let headlineMedium = PlaygroundFont.shantell(28, .semibold)
    let headlineSmall = PlaygroundFont.shantell(24, .semibold)
    let titleLarge = PlaygroundFont.shantell(22, .medium)
    let titleMedium = PlaygroundFont.shantell(16, .medium)
    let titleSmall = PlaygroundFont.shantell(14, .medium)
    let bodyLarge = PlaygroundFont.shantell(16, .regular)
    let bodyMedium = PlaygroundFont.shantell(14, .regular)
    let bodySmall = PlaygroundFont.shantell(12, .regular)
    let labelLarge = PlaygroundFont.shantell(14, .medium)
    let labelMedium = PlaygroundFont.shantell(12, .medium)
    let labelSmall = PlaygroundFont.shantell(11, .medium)
}
