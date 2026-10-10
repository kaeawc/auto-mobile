import Foundation

// `prototype_appearance_v1` (#11222, part of #11215): which of light or dark a shown prototype
// draws in, why, and the override a show can carry. One `PrototypeAppearance` per shown prototype
// drives the palette, the host chrome and the UIKit trait, so no part can disagree with another.

/// The show request's `appearance`: what "system" means for that prototype. `device` (the default)
/// follows the simulator; `light` and `dark` stand in for it without changing the simulator.
enum PrototypeAppearanceOverride: String, Equatable {
    case device, light, dark

    /// The request field as received: absent or null is `device`; anything that is not one of the
    /// three names is nil, and the show is refused rather than drawn in a mode nobody asked for.
    static func parse(_ value: Any?) -> PrototypeAppearanceOverride? {
        guard let value, !(value is NSNull) else { return .device }
        return (value as? String).flatMap(PrototypeAppearanceOverride.init(rawValue:))
    }

    /// The mode this pins, nil when it follows the device.
    var dark: Bool? {
        switch self {
        case .device: nil
        case .light: false
        case .dark: true
        }
    }
}

/// Which step of the resolution order decided the mode; the `source` the agent reports.
enum PrototypeAppearanceSource: String, Equatable {
    /// `theme.mode` is `light` or `dark`.
    case explicit
    /// The show's `appearance` is `light` or `dark`.
    case override
    /// The luminance of the flat `theme.colors.background` (else `surface`) override.
    case roleLuminance
    /// The first opaque authored background on the root's leading chain.
    case authoredBackground
    /// The device (simulator) appearance.
    case system
}

/// The appearance one shown prototype resolved to.
struct PrototypeAppearance: Equatable {
    let dark: Bool
    let source: PrototypeAppearanceSource
    /// The device's own appearance, whatever decided the mode.
    let deviceDark: Bool

    var mode: String {
        dark ? "dark" : "light"
    }

    /// `appearance` in the show result and in `get_prototype_status`.
    var wireObject: [String: Any] {
        ["mode": mode, "source": source.rawValue, "deviceDark": deviceDark]
    }

    /// The `appearance_changed` event's payload.
    var eventPayload: JSONValue {
        .object(["mode": .string(mode), "source": .string(source.rawValue)])
    }

    /// Below this, white content has more contrast than black, so the surface is a dark one.
    static let darkLuminanceCeiling = 0.179
    /// An authored background at or above this alpha is what the author painted the screen with
    /// (Android's `OPAQUE_BACKGROUND_ALPHA`).
    static let opaqueBackgroundAlpha = 0.99

    /// The one resolution order, the same on Android (#11215 D4):
    /// 1. `theme.mode` `light` or `dark`;
    /// 2. the show's `appearance` override;
    /// 3. the luminance of the flat `background` (else `surface`) role override;
    /// 4. the first opaque authored background on the root's leading chain;
    /// 5. the device.
    /// `theme.mode: "system"` asks for the system setting outright, so it skips 3 and 4: it is the
    /// override when one is set, else the device. `root` is nil when only the theme is known.
    static func resolve(
        theme: PrototypeTheme?,
        root: PrototypeNode?,
        state: [String: JSONValue] = [:],
        pages: [String: Int] = [:],
        override: PrototypeAppearanceOverride = .device,
        deviceDark: Bool
    )
        -> PrototypeAppearance
    {
        func resolved(_ dark: Bool, _ source: PrototypeAppearanceSource) -> PrototypeAppearance {
            PrototypeAppearance(dark: dark, source: source, deviceDark: deviceDark)
        }
        let system = override.dark.map { resolved($0, .override) } ?? resolved(deviceDark, .system)
        switch theme?.mode {
        case "light": return resolved(false, .explicit)
        case "dark": return resolved(true, .explicit)
        case "system": return system
        default: break
        }
        if override.dark != nil { return system }
        // Only the flat overrides count: a `light` / `dark` role map is chosen by the mode, so it
        // cannot also decide it.
        let roles = theme?.colors?.roles ?? [:]
        if let surface = PrototypeRGBA(hex: roles["background"]) ?? PrototypeRGBA(hex: roles["surface"]) {
            return resolved(surface.luminance < darkLuminanceCeiling, .roleLuminance)
        }
        if let background = root?.authoredBackground(state: state, pages: pages) {
            return resolved(background.luminance < darkLuminanceCeiling, .authoredBackground)
        }
        return system
    }
}

extension PrototypeNode {
    /// Android's `prototypeAuthoredTheme`: the first opaque background on the tree's leading chain
    /// (this node, then its first visible child, and so on; a pager continues into its current
    /// page) is what the author painted the screen with. A hidden node paints nothing and is
    /// skipped. Only a single hex value takes part: a role name and a `{light, dark}` pair depend
    /// on the mode, so neither can decide it, and the search continues below them.
    func authoredBackground(state: [String: JSONValue], pages: [String: Int]) -> PrototypeRGBA? {
        var node: PrototypeNode? = self
        while let current = node {
            if current.isShown(state: state),
               case let .single(value)? = current.resolvedStyle(state: state)?.background,
               let color = PrototypeRGBA(hex: value), color.alpha >= PrototypeAppearance.opaqueBackgroundAlpha
            {
                return color
            }
            let children = current.child.map { [$0] } ?? current.children ?? []
            if current.type == "pager" {
                let page = current.id.flatMap { pages[$0] } ?? 0
                node = children.indices.contains(page) ? children[page] : nil
            } else {
                node = children.first { $0.isShown(state: state) }
            }
        }
        return nil
    }

    private func isShown(state: [String: JSONValue]) -> Bool {
        visibleWhen?.holds(state) ?? true
    }
}
