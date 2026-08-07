import SwiftUI

// MARK: - Playground typography

/// Shantell Sans (SIL OFL) — the hand-drawn marker family behind every type role,
/// mirroring the Android design system's scale. The font is a variable TTF anchored
/// on its default instance; `.weight()` drives the `wght` axis on iOS.
/// Font + licence: `Sources/Resources/Fonts/ShantellSans.ttf`, `licenses/ShantellSans-OFL.txt`.
enum PlaygroundFont {
    /// PostScript name of the vendored variable font's default instance.
    static let baseName = "ShantellSans-Light"

    /// `relativeTo` anchors each role to its semantic `TextStyle` so the font
    /// follows that role's Dynamic Type / accessibility scaling curve, not the
    /// default body curve.
    static func shantell(_ size: CGFloat, _ weight: Font.Weight, relativeTo textStyle: Font.TextStyle) -> Font {
        Font.custom(baseName, size: size, relativeTo: textStyle).weight(weight)
    }
}

/// Type roles mirroring the Android `AutoMobileTypography` scale (Material sizes,
/// Shantell Sans family), each anchored to a matching SwiftUI `TextStyle` for
/// correct Dynamic Type scaling.
struct PlaygroundTypography {
    let displayLarge = PlaygroundFont.shantell(57, .regular, relativeTo: .largeTitle)
    let displayMedium = PlaygroundFont.shantell(45, .regular, relativeTo: .largeTitle)
    let displaySmall = PlaygroundFont.shantell(36, .regular, relativeTo: .largeTitle)
    let headlineLarge = PlaygroundFont.shantell(32, .semibold, relativeTo: .title)
    let headlineMedium = PlaygroundFont.shantell(28, .semibold, relativeTo: .title2)
    let headlineSmall = PlaygroundFont.shantell(24, .semibold, relativeTo: .title3)
    let titleLarge = PlaygroundFont.shantell(22, .medium, relativeTo: .title3)
    let titleMedium = PlaygroundFont.shantell(16, .medium, relativeTo: .headline)
    let titleSmall = PlaygroundFont.shantell(14, .medium, relativeTo: .subheadline)
    let bodyLarge = PlaygroundFont.shantell(16, .regular, relativeTo: .body)
    let bodyMedium = PlaygroundFont.shantell(14, .regular, relativeTo: .callout)
    let bodySmall = PlaygroundFont.shantell(12, .regular, relativeTo: .footnote)
    let labelLarge = PlaygroundFont.shantell(14, .medium, relativeTo: .subheadline)
    let labelMedium = PlaygroundFont.shantell(12, .medium, relativeTo: .caption)
    let labelSmall = PlaygroundFont.shantell(11, .medium, relativeTo: .caption2)
}
