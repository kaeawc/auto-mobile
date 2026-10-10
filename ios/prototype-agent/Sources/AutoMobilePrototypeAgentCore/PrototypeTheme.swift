import Foundation

/// A straight sRGB colour, kept UIKit/SwiftUI-free so the theme logic runs under `swift test`.
struct PrototypeRGBA: Equatable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double = 1

    /// The spec's Android-style hex: `#RRGGBB` or `#AARRGGBB`. Anything else is nil.
    init?(hex: String?) {
        // `UInt64(_:radix:)` alone would take a sign, so "#+12345" must not pass as a colour.
        guard let hex, hex.hasPrefix("#"), hex.count == 7 || hex.count == 9,
              hex.dropFirst().allSatisfy(\.isHexDigit),
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

    func contrast(with other: PrototypeRGBA) -> Double {
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

    static func hsl(_ hue: Double, _ saturation: Double, _ lightness: Double) -> PrototypeRGBA {
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
        return PrototypeRGBA(red: r + m, green: g + m, blue: b + m)
    }
}

/// The spec's `theme.colors`: a seed, the device-colour source, per-role hex overrides, and
/// `light` / `dark` role maps for one resolved mode (#11218).
struct PrototypeThemeColors: Decodable, Equatable {
    let seed: String?
    let source: String?
    /// Only the Material 3 role names (`PrototypePalette.roleNames`), hex values as authored.
    let roles: [String: String]
    /// Role overrides for one resolved mode, applied after `roles` by `PrototypePalette.make`.
    let light: [String: String]
    let dark: [String: String]
    /// Top-level keys that are neither a field nor a role name, sorted. They are not applied; the
    /// agent logs them when the spec is shown.
    let unknownKeys: [String]

    private static let fieldNames: Set<String> = ["seed", "source", "light", "dark"]

    init(from decoder: Decoder) throws {
        let all = try decoder.singleValueContainer().decode([String: JSONValue].self)
        seed = Self.text(all["seed"])
        source = Self.text(all["source"])
        roles = all.compactMapValues { Self.text($0) }.filter { PrototypePalette.roleNames.contains($0.key) }
        light = try Self.modeOverrides(all["light"], mode: "light")
        dark = try Self.modeOverrides(all["dark"], mode: "dark")
        unknownKeys = all.keys
            .filter { !Self.fieldNames.contains($0) && !PrototypePalette.roleNames.contains($0) }
            .sorted()
    }

    private static func text(_ value: JSONValue?) -> String? {
        if case let .string(text)? = value { text } else { nil }
    }

    /// A mode map is new with `prototype_theme_modes_v1` and has no host-independent fallback that
    /// is safe to draw, so anything but a non-empty `{role: hex}` object fails the decode: a seed,
    /// an unknown role and a role name used as a value are all refused.
    private static func modeOverrides(_ value: JSONValue?, mode: String) throws -> [String: String] {
        guard let value else { return [:] }
        let path = "theme.colors.\(mode)"
        guard case let .object(fields) = value, !fields.isEmpty else {
            throw PrototypeThemeModes.violation(path, "Expected a non-empty {role: hex} map")
        }
        var overrides: [String: String] = [:]
        for (role, entry) in fields.sorted(by: { $0.key < $1.key }) {
            guard PrototypePalette.roleNames.contains(role) else {
                throw PrototypeThemeModes.violation("\(path).\(role)", "Unknown colour role")
            }
            guard let hex = text(entry), PrototypeRGBA(hex: hex) != nil else {
                throw PrototypeThemeModes.violation("\(path).\(role)", "Expected #RRGGBB or #AARRGGBB")
            }
            overrides[role] = hex
        }
        return overrides
    }
}

struct PrototypeThemeTypography: Decodable, Equatable {
    let scale: Double?
    let fontFamily: String?
}

struct PrototypeThemeShapes: Decodable, Equatable {
    let corner: String?
}

/// The spec's `theme`: colours via `PrototypePalette`, type scale via `PrototypeTypography`, corner
/// scale via `PrototypeShapes`.
struct PrototypeTheme: Decodable, Equatable {
    let mode: String?
    let colors: PrototypeThemeColors?
    let typography: PrototypeThemeTypography?
    let shapes: PrototypeThemeShapes?

    init(
        mode: String? = nil,
        colors: PrototypeThemeColors? = nil,
        typography: PrototypeThemeTypography? = nil,
        shapes: PrototypeThemeShapes? = nil
    ) {
        self.mode = mode
        self.colors = colors
        self.typography = typography
        self.shapes = shapes
    }
}

/// SwiftUI-free mirror of `Font.Design`.
enum PrototypeFontDesign: Equatable {
    case standard, serif, monospaced
}

/// A resolved text role: points, CSS-style weight, and line height / tracking in points.
struct PrototypeTextRole: Equatable {
    var size: Double
    var weight: Int
    var lineHeight: Double
    var letterSpacing: Double
}

/// The Material 3 type scale, hard-coded from Compose's `Typography()` defaults, with the theme's
/// `scale` (size and line height, not tracking, as Android's `prototypeTypography`) and family.
struct PrototypeTypography: Equatable {
    let scale: Double
    /// The theme family; it only applies when a node names no family of its own.
    let design: PrototypeFontDesign

    static let standard = PrototypeTypography(scale: 1, design: .standard)

    init(scale: Double, design: PrototypeFontDesign) {
        self.scale = scale
        self.design = design
    }

    init(theme: PrototypeThemeTypography?) {
        scale = theme?.scale ?? 1
        design = switch theme?.fontFamily {
        case "serif": .serif
        case "mono": .monospaced
        default: .standard
        }
    }

    static let roleNames: Set<String> = Set(table.keys)

    /// The scaled role a `textStyle` token names; nil for no or an unknown token.
    func role(_ token: String?) -> PrototypeTextRole? {
        guard let token, let base = Self.table[token] else { return nil }
        return PrototypeTextRole(
            size: base.size * scale,
            weight: base.weight,
            lineHeight: base.lineHeight * scale,
            letterSpacing: base.letterSpacing
        )
    }

    /// Compose Material 3 `Typography()` defaults: size, weight, line height, letter spacing.
    static let table: [String: PrototypeTextRole] = [
        "displayLarge": PrototypeTextRole(size: 57, weight: 400, lineHeight: 64, letterSpacing: -0.25),
        "displayMedium": PrototypeTextRole(size: 45, weight: 400, lineHeight: 52, letterSpacing: 0),
        "displaySmall": PrototypeTextRole(size: 36, weight: 400, lineHeight: 44, letterSpacing: 0),
        "headlineLarge": PrototypeTextRole(size: 32, weight: 400, lineHeight: 40, letterSpacing: 0),
        "headlineMedium": PrototypeTextRole(size: 28, weight: 400, lineHeight: 36, letterSpacing: 0),
        "headlineSmall": PrototypeTextRole(size: 24, weight: 400, lineHeight: 32, letterSpacing: 0),
        "titleLarge": PrototypeTextRole(size: 22, weight: 400, lineHeight: 28, letterSpacing: 0),
        "titleMedium": PrototypeTextRole(size: 16, weight: 500, lineHeight: 24, letterSpacing: 0.15),
        "titleSmall": PrototypeTextRole(size: 14, weight: 500, lineHeight: 20, letterSpacing: 0.1),
        "bodyLarge": PrototypeTextRole(size: 16, weight: 400, lineHeight: 24, letterSpacing: 0.5),
        "bodyMedium": PrototypeTextRole(size: 14, weight: 400, lineHeight: 20, letterSpacing: 0.25),
        "bodySmall": PrototypeTextRole(size: 12, weight: 400, lineHeight: 16, letterSpacing: 0.4),
        "labelLarge": PrototypeTextRole(size: 14, weight: 500, lineHeight: 20, letterSpacing: 0.1),
        "labelMedium": PrototypeTextRole(size: 12, weight: 500, lineHeight: 16, letterSpacing: 0.5),
        "labelSmall": PrototypeTextRole(size: 11, weight: 500, lineHeight: 16, letterSpacing: 0.5),
    ]

    /// What a text node draws: a `textStyle` role supplies size, weight, line height and tracking;
    /// explicit style fields win. Without a role, the authored 14 pt default is not scaled.
    struct Resolved: Equatable {
        let size: Double
        let weight: Int
        /// nil when neither the node nor a role names a line height.
        let lineHeight: Double?
        let letterSpacing: Double
        let design: PrototypeFontDesign
    }

    func resolve(_ style: Style?) -> Resolved {
        let role = role(style?.textStyle)
        let design: PrototypeFontDesign = switch style?.fontFamily {
        case .keyword("serif")?: .serif
        case .keyword("monospace")?: .monospaced
        // An uploaded font asset is not delivered to the agent, so it uses the system font.
        case .some: .standard
        case nil: self.design
        }
        return Resolved(
            size: style?.textSize ?? role?.size ?? 14,
            weight: style?.fontWeight ?? role?.weight ?? 400,
            lineHeight: style?.lineHeight ?? role?.lineHeight,
            letterSpacing: style?.letterSpacing ?? role?.letterSpacing ?? 0,
            design: design
        )
    }
}

/// The Material 3 corner scale. `medium` is the stock one; `shapes.corner` shifts every step, and
/// `full` makes every step a pill. A `cornerRadius` token resolves through it.
struct PrototypeShapes: Equatable {
    static let stepNames = ["extraSmall", "small", "medium", "large", "extraLarge", "full"]
    /// Radius large enough that any side length is fully rounded.
    static let pill = 9999.0

    /// extraSmall, small, medium, large, extraLarge radii in points.
    let steps: [Double]

    static let standard = PrototypeShapes(steps: [4, 8, 12, 16, 28])

    init(steps: [Double]) { self.steps = steps }

    init(theme: PrototypeThemeShapes?) {
        steps = switch theme?.corner {
        case "none": [0, 0, 0, 0, 0]
        case "small": [2, 4, 6, 8, 12]
        case "large": [8, 12, 20, 28, 40]
        case "full": Array(repeating: Self.pill, count: 5)
        default: Self.standard.steps
        }
    }

    /// Tokens become the theme's radius; numbers and per-corner radii are unchanged.
    func resolve(_ radius: CornerRadius) -> CornerRadius {
        guard case let .token(name) = radius else { return radius }
        if name == "full" { return .uniform(Self.pill) }
        guard let index = Self.stepNames.firstIndex(of: name), index < steps.count else { return .uniform(0) }
        return .uniform(steps[index])
    }
}

/// The Material 3 colour roles a spec can name, resolved for one light or dark scheme. Mirrors
/// Android's `PrototypeTheme.kt`: baseline Material palette, optionally replaced by a seed-derived
/// scheme, then the flat role overrides, then the `light` or `dark` role map for the resolved mode.
struct PrototypePalette: Equatable {
    let dark: Bool
    /// True when the spec carried a `theme`, so unstyled content follows the palette.
    let themed: Bool
    let colors: [String: PrototypeRGBA]

    static let roleNames: Set<String> = Set(baselineLight.keys)

    func color(role: String) -> PrototypeRGBA? { colors[role] }

    /// A hex literal is itself; any other string names a role in this palette (nil if unknown).
    func resolve(_ spec: String?) -> PrototypeRGBA? {
        guard let spec else { return nil }
        return spec.hasPrefix("#") ? PrototypeRGBA(hex: spec) : colors[spec]
    }

    /// A spec colour slot in this palette's mode: a `{light, dark}` pair gives its side for
    /// `dark`, and that value is then a hex literal or a role like any single value.
    func resolve(_ spec: PrototypeModeValue?) -> PrototypeRGBA? {
        resolve(spec?.value(dark: dark))
    }

    /// The opacity the `scrim` role is drawn at when it is used as a scrim: Android's
    /// `PROTOTYPE_SHEET_SCRIM_ALPHA`, its default for a sheet with no authored scrim.
    static let scrimRoleAlpha = 0.4

    /// A scrim slot (`window.placement.scrim`, a bottomSheet `scrim`), the one place both scrims
    /// resolve (owner decision 2026-10-10, #11215). Only the `scrim` role gets an alpha: named
    /// directly or as the resolved side of a pair, it is the scheme's scrim colour at
    /// `scrimRoleAlpha`, since the role itself is opaque. Any other role is its colour unchanged,
    /// and a hex value keeps exactly the authored alpha.
    func scrim(_ spec: PrototypeModeValue?) -> PrototypeRGBA? {
        let value = spec?.value(dark: dark)
        guard value == "scrim", var color = colors["scrim"] else { return resolve(value) }
        color.alpha = Self.scrimRoleAlpha
        return color
    }

    /// The asset id an image slot names in this palette's mode.
    func asset(_ slot: PrototypeModeValue?) -> String? {
        slot?.value(dark: dark)
    }

    /// The palette for a theme alone, with no tree to infer from: `systemDark` decides when the
    /// theme has no `mode` (or `system`) and no surface override. See `PrototypeAppearance.resolve`.
    static func make(theme: PrototypeTheme?, systemDark: Bool) -> PrototypePalette {
        make(theme: theme, dark: PrototypeAppearance.resolve(theme: theme, root: nil, deviceDark: systemDark).dark)
    }

    /// The palette for an already resolved mode (`PrototypeAppearance.dark`).
    static func make(theme: PrototypeTheme?, dark: Bool) -> PrototypePalette {
        let roles = theme?.colors?.roles ?? [:]
        var colors = dark ? baselineDark : baselineLight
        // Device (dynamic) colour does not exist on iOS: `source: device` falls through to the seed
        // or the baseline, as Android does below API 31.
        if let seed = PrototypeRGBA(hex: theme?.colors?.seed) {
            colors.merge(seedScheme(seed: seed, dark: dark)) { _, derived in derived }
        }
        // Flat overrides hold in both modes; the resolved mode's map is painted over them.
        let modeRoles = (dark ? theme?.colors?.dark : theme?.colors?.light) ?? [:]
        for overrides in [roles, modeRoles] {
            for (role, hex) in overrides {
                if let color = PrototypeRGBA(hex: hex) { colors[role] = color }
            }
        }
        return PrototypePalette(dark: dark, themed: theme != nil, colors: colors)
    }

    // MARK: Seed scheme

    /// A Material 3 style scheme from one colour. No shared tonal-palette table exists in this
    /// repo, so this is the same HSL approximation Android uses (no HCT): primary keeps the seed's
    /// hue and clamped saturation, secondary is a muted version, tertiary is rotated 60 degrees,
    /// and neutrals carry a trace of the hue. Tones follow the Material light (primary 40,
    /// containers 90) and dark (primary 80, containers 30) assignments.
    static func seedScheme(seed: PrototypeRGBA, dark: Bool) -> [String: PrototypeRGBA] {
        let (hue, seedSaturation) = seed.hueAndSaturation
        let chroma = seedSaturation == 0 ? 0 : min(max(seedSaturation, 0.25), 0.85)
        let neutral = 0.06

        func tone(_ h: Double, _ s: Double, _ light: Double, _ darkTone: Double) -> PrototypeRGBA {
            .hsl(h, s, dark ? darkTone : light)
        }
        let surface = tone(hue, neutral, 0.98, 0.07)

        // HSL lightness is not perceptual: walk the accent away from the surface until legible.
        func accent(_ h: Double, _ s: Double) -> PrototypeRGBA {
            let step = dark ? 0.02 : -0.02
            var lightness = dark ? 0.80 : 0.40
            var color = PrototypeRGBA.hsl(h, s, lightness)
            while color.contrast(with: surface) < 3, (0.05 ... 0.95).contains(lightness + step) {
                lightness += step
                color = .hsl(h, s, lightness)
            }
            return color
        }
        func onRole(_ role: PrototypeRGBA, _ h: Double, _ s: Double) -> PrototypeRGBA {
            let light = PrototypeRGBA.hsl(h, s, 0.98)
            let darkOn = PrototypeRGBA.hsl(h, s, 0.04)
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

    private static func table(_ values: [String: UInt32]) -> [String: PrototypeRGBA] {
        values.mapValues { PrototypeRGBA(rgb: $0) }
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
