import Foundation

/// A straight sRGB colour, kept UIKit/SwiftUI-free so the theme logic runs under `swift test`.
struct OverlayRGBA: Equatable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double = 1

    /// The spec's Android-style hex: `#RRGGBB` or `#AARRGGBB`. Anything else is nil.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7 || hex.count == 9,
              let value = UInt64(hex.dropFirst(), radix: 16) else { return nil }
        alpha = hex.count == 9 ? Double((value >> 24) & 0xFF) / 255 : 1
        red = Double((value >> 16) & 0xFF) / 255
        green = Double((value >> 8) & 0xFF) / 255
        blue = Double(value & 0xFF) / 255
    }

    init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    /// Opaque colour from an `0xRRGGBB` literal.
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }

    /// WCAG relative luminance, as Compose's `Color.luminance()`.
    var luminance: Double {
        func linear(_ value: Double) -> Double {
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    func contrast(with other: OverlayRGBA) -> Double {
        let a = luminance
        let b = other.luminance
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// Hue in degrees [0, 360) and HSL saturation [0, 1].
    var hueAndSaturation: (hue: Double, saturation: Double) {
        let maxValue = max(red, green, blue)
        let minValue = min(red, green, blue)
        let delta = maxValue - minValue
        guard delta > 0 else { return (0, 0) }
        let lightness = (maxValue + minValue) / 2
        let saturation = delta / (1 - abs(2 * lightness - 1))
        let sector: Double
        if maxValue == red {
            sector = ((green - blue) / delta).truncatingRemainder(dividingBy: 6)
        } else if maxValue == green {
            sector = (blue - red) / delta + 2
        } else {
            sector = (red - green) / delta + 4
        }
        return ((sector * 60 + 360).truncatingRemainder(dividingBy: 360), saturation)
    }

    static func hsl(_ hue: Double, _ saturation: Double, _ lightness: Double) -> OverlayRGBA {
        let h = (hue.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        let s = min(max(saturation, 0), 1)
        let l = min(max(lightness, 0), 1)
        let chroma = (1 - abs(2 * l - 1)) * s
        let x = chroma * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - chroma / 2
        let (r, g, b): (Double, Double, Double) = switch Int(h / 60) {
        case 0: (chroma, x, 0)
        case 1: (x, chroma, 0)
        case 2: (0, chroma, x)
        case 3: (0, x, chroma)
        case 4: (x, 0, chroma)
        default: (chroma, 0, x)
        }
        return OverlayRGBA(red: r + m, green: g + m, blue: b + m)
    }
}

/// The spec's `theme.colors`: a seed, the device-colour source, and per-role hex overrides.
struct OverlayThemeColors: Decodable, Equatable {
    let seed: String?
    let source: String?
    /// Only the Material 3 role names (`OverlayPalette.roleNames`), hex values as authored.
    let roles: [String: String]

    init(from decoder: Decoder) throws {
        let all = try decoder.singleValueContainer().decode([String: String].self)
        seed = all["seed"]
        source = all["source"]
        roles = all.filter { OverlayPalette.roleNames.contains($0.key) }
    }
}

/// The spec's `theme`. `typography` and `shapes` are not applied on iOS yet.
struct OverlayTheme: Decodable, Equatable {
    let mode: String?
    let colors: OverlayThemeColors?
}

/// The Material 3 colour roles a spec can name, resolved for one light or dark scheme. Mirrors
/// Android's `OverlayTheme.kt`: baseline Material palette, optionally replaced by a seed-derived
/// scheme, then explicit role overrides painted last.
struct OverlayPalette: Equatable {
    let dark: Bool
    /// True when the spec carried a `theme`, so unstyled content follows the palette.
    let themed: Bool
    let colors: [String: OverlayRGBA]

    static let roleNames: Set<String> = Set(baselineLight.keys)

    func color(role: String) -> OverlayRGBA? { colors[role] }

    /// A hex literal is itself; any other string names a role in this palette (nil if unknown).
    func resolve(_ spec: String?) -> OverlayRGBA? {
        guard let spec else { return nil }
        return spec.hasPrefix("#") ? OverlayRGBA(hex: spec) : colors[spec]
    }

    /// `systemDark` decides when the theme has no `mode` (or `system`) and no surface override.
    static func make(theme: OverlayTheme?, systemDark: Bool) -> OverlayPalette {
        let roles = theme?.colors?.roles ?? [:]
        let dark: Bool
        switch theme?.mode {
        case "light": dark = false
        case "dark": dark = true
        case "system": dark = systemDark
        default:
            // No mode: an explicit background (else surface) override is the screen colour the
            // author chose, so its luminance decides, as Android's overlayRoleSurfaceDark does.
            dark = (OverlayRGBA(hex: roles["background"]) ?? OverlayRGBA(hex: roles["surface"]))
                .map { $0.luminance < darkLuminanceCeiling } ?? systemDark
        }
        var colors = dark ? baselineDark : baselineLight
        // Device (dynamic) colour does not exist on iOS: `source: device` falls through to the seed
        // or the baseline, as Android does below API 31.
        if let seed = OverlayRGBA(hex: theme?.colors?.seed) {
            colors.merge(seedScheme(seed: seed, dark: dark)) { _, derived in derived }
        }
        for (role, hex) in roles {
            if let color = OverlayRGBA(hex: hex) { colors[role] = color }
        }
        return OverlayPalette(dark: dark, themed: theme != nil, colors: colors)
    }

    /// Below this, white content has more contrast than black, so the surface is a dark one.
    private static let darkLuminanceCeiling = 0.179

    // MARK: Seed scheme

    /// A Material 3 style scheme from one colour. No shared tonal-palette table exists in this
    /// repo, so this is the same HSL approximation Android uses (no HCT): primary keeps the seed's
    /// hue and clamped saturation, secondary is a muted version, tertiary is rotated 60 degrees,
    /// and neutrals carry a trace of the hue. Tones follow the Material light (primary 40,
    /// containers 90) and dark (primary 80, containers 30) assignments.
    static func seedScheme(seed: OverlayRGBA, dark: Bool) -> [String: OverlayRGBA] {
        let (hue, seedSaturation) = seed.hueAndSaturation
        let chroma = seedSaturation == 0 ? 0 : min(max(seedSaturation, 0.25), 0.85)
        let neutral = 0.06

        func tone(_ h: Double, _ s: Double, _ light: Double, _ darkTone: Double) -> OverlayRGBA {
            .hsl(h, s, dark ? darkTone : light)
        }
        let surface = tone(hue, neutral, 0.98, 0.07)

        // HSL lightness is not perceptual: walk the accent away from the surface until legible.
        func accent(_ h: Double, _ s: Double) -> OverlayRGBA {
            let step = dark ? 0.02 : -0.02
            var lightness = dark ? 0.80 : 0.40
            var color = OverlayRGBA.hsl(h, s, lightness)
            while color.contrast(with: surface) < 3, (0.05 ... 0.95).contains(lightness + step) {
                lightness += step
                color = .hsl(h, s, lightness)
            }
            return color
        }
        func onRole(_ role: OverlayRGBA, _ h: Double, _ s: Double) -> OverlayRGBA {
            let light = OverlayRGBA.hsl(h, s, 0.98)
            let darkOn = OverlayRGBA.hsl(h, s, 0.04)
            return role.contrast(with: light) >= role.contrast(with: darkOn) ? light : darkOn
        }

        let secondaryChroma = chroma * 0.35
        let tertiaryHue = hue + 60
        let tertiaryChroma = chroma * 0.6
        let primary = accent(hue, chroma)
        let secondary = accent(hue, secondaryChroma)
        let tertiary = accent(tertiaryHue, tertiaryChroma)
        let primaryContainer = tone(hue, chroma, 0.90, 0.30)
        let secondaryContainer = tone(hue, secondaryChroma, 0.90, 0.30)
        let tertiaryContainer = tone(tertiaryHue, tertiaryChroma, 0.90, 0.30)
        return [
            "primary": primary,
            "onPrimary": onRole(primary, hue, chroma),
            "primaryContainer": primaryContainer,
            "onPrimaryContainer": onRole(primaryContainer, hue, chroma),
            "secondary": secondary,
            "onSecondary": onRole(secondary, hue, secondaryChroma),
            "secondaryContainer": secondaryContainer,
            "onSecondaryContainer": onRole(secondaryContainer, hue, secondaryChroma),
            "tertiary": tertiary,
            "onTertiary": onRole(tertiary, tertiaryHue, tertiaryChroma),
            "tertiaryContainer": tertiaryContainer,
            "onTertiaryContainer": onRole(tertiaryContainer, tertiaryHue, tertiaryChroma),
            "background": surface,
            "onBackground": tone(hue, neutral, 0.10, 0.90),
            "surface": surface,
            "onSurface": tone(hue, neutral, 0.10, 0.90),
            "surfaceVariant": tone(hue, neutral * 2, 0.90, 0.25),
            "onSurfaceVariant": tone(hue, neutral * 2, 0.30, 0.80),
            "surfaceContainerLowest": tone(hue, neutral, 1.00, 0.04),
            "surfaceContainerLow": tone(hue, neutral, 0.96, 0.10),
            "surfaceContainer": tone(hue, neutral, 0.94, 0.12),
            "surfaceContainerHigh": tone(hue, neutral, 0.92, 0.17),
            "surfaceContainerHighest": tone(hue, neutral, 0.90, 0.22),
            "outline": tone(hue, neutral * 2, 0.46, 0.60),
            "outlineVariant": tone(hue, neutral * 2, 0.80, 0.30),
        ]
    }

    // MARK: Baseline (Compose `lightColorScheme()` / `darkColorScheme()`)

    private static func table(_ values: [String: UInt32]) -> [String: OverlayRGBA] {
        values.mapValues { OverlayRGBA(rgb: $0) }
    }

    static let baselineLight = table([
        "primary": 0x6750A4, "onPrimary": 0xFFFFFF, "primaryContainer": 0xEADDFF,
        "onPrimaryContainer": 0x4F378B, "inversePrimary": 0xD0BCFF,
        "secondary": 0x625B71, "onSecondary": 0xFFFFFF, "secondaryContainer": 0xE8DEF8,
        "onSecondaryContainer": 0x4A4458,
        "tertiary": 0x7D5260, "onTertiary": 0xFFFFFF, "tertiaryContainer": 0xFFD8E4,
        "onTertiaryContainer": 0x633B48,
        "background": 0xFEF7FF, "onBackground": 0x1D1B20, "surface": 0xFEF7FF, "onSurface": 0x1D1B20,
        "surfaceVariant": 0xE7E0EC, "onSurfaceVariant": 0x49454F, "surfaceTint": 0x6750A4,
        "inverseSurface": 0x322F35, "inverseOnSurface": 0xF5EFF7,
        "error": 0xB3261E, "onError": 0xFFFFFF, "errorContainer": 0xF9DEDC, "onErrorContainer": 0x410E0B,
        "outline": 0x79747E, "outlineVariant": 0xCAC4D0, "scrim": 0x000000,
        "surfaceBright": 0xFEF7FF, "surfaceDim": 0xDED8E1, "surfaceContainerLowest": 0xFFFFFF,
        "surfaceContainerLow": 0xF7F2FA, "surfaceContainer": 0xF3EDF7,
        "surfaceContainerHigh": 0xECE6F0, "surfaceContainerHighest": 0xE6E0E9,
    ])

    static let baselineDark = table([
        "primary": 0xD0BCFF, "onPrimary": 0x381E72, "primaryContainer": 0x4F378B,
        "onPrimaryContainer": 0xEADDFF, "inversePrimary": 0x6750A4,
        "secondary": 0xCCC2DC, "onSecondary": 0x332D41, "secondaryContainer": 0x4A4458,
        "onSecondaryContainer": 0xE8DEF8,
        "tertiary": 0xEFB8C8, "onTertiary": 0x492532, "tertiaryContainer": 0x633B48,
        "onTertiaryContainer": 0xFFD8E4,
        "background": 0x141218, "onBackground": 0xE6E0E9, "surface": 0x141218, "onSurface": 0xE6E0E9,
        "surfaceVariant": 0x49454F, "onSurfaceVariant": 0xCAC4D0, "surfaceTint": 0xD0BCFF,
        "inverseSurface": 0xE6E0E9, "inverseOnSurface": 0x322F35,
        "error": 0xF2B8B5, "onError": 0x601410, "errorContainer": 0x8C1D18, "onErrorContainer": 0xF9DEDC,
        "outline": 0x938F99, "outlineVariant": 0x49454F, "scrim": 0x000000,
        "surfaceBright": 0x3B383E, "surfaceDim": 0x141218, "surfaceContainerLowest": 0x0F0D13,
        "surfaceContainerLow": 0x1D1B20, "surfaceContainer": 0x211F26,
        "surfaceContainerHigh": 0x2B2930, "surfaceContainerHighest": 0x36343B,
    ])
}
