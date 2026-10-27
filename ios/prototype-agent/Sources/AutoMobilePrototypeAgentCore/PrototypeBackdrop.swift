import Foundation

// `window.backdrop` (#15126, `prototype_backdrop_v1`): blurs what is behind the prototype window.
// Contract and Android renderer: docs/design-docs/plat/android/prototype-ux.md ("Frosted backdrop").
// Every decision here is pure so it is testable without UIKit; PrototypeLayers draws the plan.

/// The spec's `window.backdrop`. The strict validator has already checked the closed material list,
/// the 0-150 whole-dp `blur` and the single-colour `tint`.
struct BackdropSpec: Decodable, Equatable {
    let material: String
    let blur: Int?
    let tint: String?
}

enum PrototypeBackdropMaterial: String, Equatable {
    case ultraThin, thin, regular, thick, glass

    /// SwiftUI `Material` radii are fixed, so an authored `blur` picks the nearest of these (dp),
    /// matching Android's per-material radii.
    static let radii: [(PrototypeBackdropMaterial, Int)] = [
        (.ultraThin, 8), (.thin, 16), (.regular, 24), (.thick, 40),
    ]

    func nearest(toBlur blur: Int?) -> PrototypeBackdropMaterial {
        guard self != .glass, let blur else { return self }
        return Self.radii.min { abs($0.1 - blur) < abs($1.1 - blur) }?.0 ?? self
    }
}

/// What a show with a backdrop draws, and what it reports as `backdrop`.
struct PrototypeBackdropPlan: Equatable {
    enum Mode: String { case blur, fallback }

    /// Tonal fill opacity for the fallback; the same on Android.
    static let tonalAlpha = 0.85
    /// Light tint over a real blur.
    static let blurTintAlpha = 0.35
    /// The role the tonal fill uses when no `tint` is authored.
    static let defaultTonalRole = "surfaceContainer"
    /// `glass` is Liquid Glass.
    static let glassMinimumMajorVersion = 26

    let mode: Mode
    let material: PrototypeBackdropMaterial
    let tint: String?

    /// `reduceTransparency` is the system accessibility setting: Materials turn opaque under it, so
    /// the tonal fill is drawn deliberately. Below iOS 26 `glass` falls back too.
    static func resolve(_ spec: BackdropSpec, osMajorVersion: Int, reduceTransparency: Bool)
        -> PrototypeBackdropPlan
    {
        let material = PrototypeBackdropMaterial(rawValue: spec.material) ?? .regular
        let glassUnavailable = material == .glass && osMajorVersion < glassMinimumMajorVersion
        return PrototypeBackdropPlan(
            mode: reduceTransparency || glassUnavailable ? .fallback : .blur,
            material: material.nearest(toBlur: spec.blur),
            tint: spec.tint
        )
    }
}
