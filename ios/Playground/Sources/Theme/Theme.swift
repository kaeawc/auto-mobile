import SwiftUI

// MARK: - AutoMobile Theme

struct AutoMobileTheme {
    let colorScheme: ColorScheme

    private var dark: Bool { colorScheme == .dark }

    /// Hand-drawn type scale and shape tokens (mirror the Android design system).
    let typography = PlaygroundTypography()
    let shapes = PlaygroundShapes()

    /// Primary colors — icon-derived marker red.
    var primary: Color { dark ? .pgDarkPrimary : .pgLightPrimary }
    var onPrimary: Color { dark ? .pgDarkOnPrimary : .pgLightOnPrimary }

    /// Secondary colors — swing / sky blue.
    var secondary: Color { dark ? .pgDarkSecondary : .pgLightSecondary }
    var onSecondary: Color { dark ? .pgDarkOnSecondary : .pgLightOnSecondary }

    /// Tertiary colors — sun yellow.
    var tertiary: Color { dark ? .pgDarkTertiary : .pgLightTertiary }
    var onTertiary: Color { dark ? .pgDarkOnTertiary : .pgLightOnTertiary }

    /// Background colors — warm crayon paper.
    var background: Color { dark ? .pgDarkBackground : .pgLightBackground }
    var onBackground: Color { dark ? .pgDarkOnBackground : .pgLightOnBackground }

    /// Surface colors.
    var surface: Color { dark ? .pgDarkSurface : .pgLightSurface }
    var onSurface: Color { dark ? .pgDarkOnSurface : .pgLightOnSurface }
    var surfaceVariant: Color { dark ? Color(hex: 0x3A2F24) : Color(hex: 0xF3E8D8) }

    /// Semantic colors.
    var success: Color { .pgAccentGrassGreen }
    var warning: Color { .pgAccentConeOrange }
    var error: Color { dark ? .pgDarkError : .pgLightError }
    var onError: Color { dark ? .pgDarkOnError : .pgLightOnError }
    var info: Color { dark ? .pgDarkSecondary : .pgLightSecondary }

    /// Text colors.
    var textPrimary: Color { onSurface }
    var textSecondary: Color { onSurface.opacity(0.68) }
}

// MARK: - Environment Key

private struct AutoMobileThemeKey: EnvironmentKey {
    static let defaultValue = AutoMobileTheme(colorScheme: .light)
}

extension EnvironmentValues {
    var autoMobileTheme: AutoMobileTheme {
        get { self[AutoMobileThemeKey.self] }
        set { self[AutoMobileThemeKey.self] = newValue }
    }
}

// MARK: - Theme View Modifier

struct AutoMobileThemeModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let theme = AutoMobileTheme(colorScheme: colorScheme)
        return content
            .environment(\.autoMobileTheme, theme)
            .tint(theme.primary)
            .accentColor(theme.primary)
    }
}

extension View {
    func autoMobileTheme() -> some View {
        modifier(AutoMobileThemeModifier())
    }
}

// MARK: - Themed View Helpers

extension View {
    func autoMobileSurface() -> some View {
        modifier(AutoMobileSurfaceModifier())
    }

    func autoMobileBackground() -> some View {
        modifier(AutoMobileBackgroundModifier())
    }
}

struct AutoMobileSurfaceModifier: ViewModifier {
    @Environment(\.autoMobileTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background(theme.surface)
            .foregroundStyle(theme.onSurface)
    }
}

struct AutoMobileBackgroundModifier: ViewModifier {
    @Environment(\.autoMobileTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background(theme.background)
            .foregroundStyle(theme.onBackground)
    }
}
