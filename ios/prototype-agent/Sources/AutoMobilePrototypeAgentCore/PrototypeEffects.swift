import Foundation

/// `style.effects` (#15130, `prototype_effects_v1`): the closed, paint-only looks of #15128 decoded
/// from the validated JSON, the Swift twin of Android's `PrototypeEffects.kt`. Omitted params take
/// the same conservative defaults, which `docs/design-docs/plat/android/prototype-ux.md` lists.
///
/// Decisions the contract left to the renderers, identical on both platforms:
/// - `phase` and `animate` move only `shimmer`, `wave` and `ripple`; the other seven are static looks
///   that accept both, count against the limits, and change nothing.
/// - Colours resolve like `style.color`: hex keeps its alpha, a Material role comes from the theme, a
///   `{light, dark}` pair picks the shown mode. `scrim` is its plain scheme colour.
struct PrototypeEffect: Equatable, Sendable {
    enum Look: Equatable, Sendable {
        case noise(amount: Double, grain: Double, seed: Int, monochrome: Bool)
        case gradientMesh(colors: [PrototypeModeValue], softness: Double)
        case shimmer(color: PrototypeModeValue?, angle: Double, width: Double)
        case glow(color: PrototypeModeValue, radius: Double, intensity: Double)
        case vignette(color: PrototypeModeValue?, intensity: Double, radius: Double)
        case blur(radius: Double)
        case pixelate(cell: Double)
        case chromaticAberration(offset: Double, angle: Double)
        case wave(amplitude: Double, wavelength: Double, angle: Double)
        case ripple(amplitude: Double, wavelength: Double, centerX: Double, centerY: Double)
    }

    let look: Look
    /// The `animate.periodMs` loop, if any.
    let periodMs: Int?
    /// The authored `phase` (0-1).
    let phase: Double

    var type: String {
        switch look {
        case .noise: "noise"
        case .gradientMesh: "gradientMesh"
        case .shimmer: "shimmer"
        case .glow: "glow"
        case .vignette: "vignette"
        case .blur: "blur"
        case .pixelate: "pixelate"
        case .chromaticAberration: "chromaticAberration"
        case .wave: "wave"
        case .ripple: "ripple"
        }
    }

    /// Whether `animate` and `phase` move this effect.
    var cycles: Bool {
        switch look {
        case .shimmer, .wave, .ripple: true
        default: false
        }
    }

    /// Whether this effect makes its node run a frame clock.
    var animated: Bool { cycles && periodMs != nil }

    /// Effects that rasterize the node's own pixels through a SwiftUI `layerEffect`. SwiftUI draws a
    /// placeholder over views backed by a platform view, so these are the ones that can degrade.
    var needsLayerSampling: Bool {
        switch look {
        case .pixelate, .chromaticAberration, .wave, .ripple: true
        default: false
        }
    }
}

enum PrototypeEffects {
    static let capability = PrototypeAgentProtocol.effectsCapability

    static let defaults = Defaults()

    struct Defaults {
        let noiseAmount = 0.1
        let grain = 1.0
        let softness = 0.5
        let shimmerAngle = 20.0
        let shimmerWidth = 0.3
        let glowRadius = 12.0
        let glowIntensity = 0.6
        let vignetteIntensity = 0.4
        let vignetteRadius = 0.7
        let aberrationOffset = 2.0
        let amplitude = 4.0
        let wavelength = 48.0
        let center = 0.5
    }

    /// The reason a `degradedEffects` entry carries when SwiftUI cannot sample the node's pixels.
    static let platformReason = "platform"

    /// Node types SwiftUI backs with a platform view (UIKit controls, scroll views and the stack's
    /// marker view), where a `layerEffect` or `distortionEffect` renders a placeholder instead of the
    /// content. A descendant with an `id` counts too: the renderer reports its menu bounds through a
    /// UIKit-backed marker view behind it (`PrototypeMenuBoundsReporter`).
    static let platformBackedTypes: Set<String> = [
        "textField", "searchBar", "slider", "select", "datePicker", "timePicker",
        "scroll", "pager", "carousel", "stack", "dialog",
    ]

    // MARK: Parsing

    static func parse(_ raw: JSONValue) -> PrototypeEffect? {
        guard let fields = raw.objectFields, let type = fields["type"]?.stringValue else { return nil }
        let period = fields["animate"]?.objectFields?["periodMs"]?.numberValue.map { Int($0) }
        let phase = fields["phase"]?.numberValue ?? 0
        guard let look = look(type, fields) else { return nil }
        return PrototypeEffect(look: look, periodMs: period, phase: phase)
    }

    static func parse(_ raw: [JSONValue]?) -> [(index: Int, effect: PrototypeEffect)] {
        (raw ?? []).enumerated().compactMap { index, value in parse(value).map { (index, $0) } }
    }

    private static func mode(_ value: JSONValue?) -> PrototypeModeValue? {
        switch value {
        case let .string(text)?: return .single(text)
        case let .object(fields)?:
            guard let light = fields["light"]?.stringValue, let dark = fields["dark"]?.stringValue else { return nil }
            return .modes(light: light, dark: dark)
        default: return nil
        }
    }

    private static func look(_ type: String, _ f: [String: JSONValue]) -> PrototypeEffect.Look? {
        let fallback = defaults
        func number(_ key: String, _ fallback: Double) -> Double { f[key]?.numberValue ?? fallback }
        switch type {
        case "noise":
            return .noise(
                amount: number("amount", fallback.noiseAmount), grain: number("grain", fallback.grain),
                seed: f["seed"]?.numberValue.map { Int($0) } ?? 0, monochrome: f["monochrome"]?.boolValue ?? true
            )
        case "gradientMesh":
            guard case let .array(items)? = f["colors"] else { return nil }
            let colors = items.compactMap { mode($0) }
            return colors
                .count == 4 ? .gradientMesh(colors: colors, softness: number("softness", fallback.softness)) : nil
        case "shimmer":
            return .shimmer(
                color: mode(f["color"]), angle: number("angle", fallback.shimmerAngle),
                width: number("width", fallback.shimmerWidth)
            )
        case "glow":
            guard let color = mode(f["color"]) else { return nil }
            return .glow(
                color: color, radius: number("radius", fallback.glowRadius),
                intensity: number("intensity", fallback.glowIntensity)
            )
        case "vignette":
            return .vignette(
                color: mode(f["color"]), intensity: number("intensity", fallback.vignetteIntensity),
                radius: number("radius", fallback.vignetteRadius)
            )
        case "blur": return .blur(radius: number("radius", 0))
        case "pixelate": return .pixelate(cell: number("cell", 1))
        case "chromaticAberration":
            return .chromaticAberration(offset: number("offset", fallback.aberrationOffset), angle: number("angle", 0))
        case "wave":
            return .wave(
                amplitude: number("amplitude", fallback.amplitude),
                wavelength: number("wavelength", fallback.wavelength),
                angle: number("angle", 0)
            )
        case "ripple":
            let center = f["center"]?.objectFields
            return .ripple(
                amplitude: number("amplitude", fallback.amplitude),
                wavelength: number("wavelength", fallback.wavelength),
                centerX: center?["x"]?.numberValue ?? fallback.center,
                centerY: center?["y"]?.numberValue ?? fallback.center
            )
        default: return nil
        }
    }

    // MARK: Time

    /// Where an effect's cycle is: the authored `phase` advanced by `elapsed` seconds of a loop that
    /// lasts `periodMs`. Without `animate`, or when the effect does not cycle, it is the authored phase,
    /// which is also what a paused clock shows (`motion: "none"`, Reduce Motion).
    static func phase(of effect: PrototypeEffect, elapsed: TimeInterval) -> Double {
        guard effect.cycles, let period = effect.periodMs, period > 0 else { return effect.phase }
        let cycles = effect.phase + elapsed * 1000 / Double(period)
        return cycles - cycles.rounded(.down)
    }

    /// Whether an animated effect may run: not under `motion: "none"` or Reduce Motion. A `reduced`
    /// profile (Reduce Motion or `motion: "reduced"`) also freezes it, as looping spatial motion.
    static func runs(_ motion: PrototypeMotion) -> Bool { motion.spatial }

    // MARK: Geometry shared with the shaders

    /// Unit travel direction for an angle in degrees: 0 runs left to right, 90 top to bottom.
    static func direction(degrees: Double) -> (x: Double, y: Double) {
        let radians = degrees * .pi / 180
        return (cos(radians), sin(radians))
    }

    /// The grid offset a noise `seed` (0-65535) selects: two small components, so the value hash keeps
    /// its precision on a half-precision GPU and every seed is a different pattern.
    static func noiseSeedOffset(_ seed: Int) -> (x: Double, y: Double) {
        (Double(seed % 256) * 1.61, Double(seed / 256) * 2.37)
    }

    // MARK: Planning and reporting

    /// What a node draws: every effect, except the shader-sampled ones on a node whose subtree SwiftUI
    /// backs with a platform view.
    struct Plan: Equatable {
        let drawn: [(index: Int, effect: PrototypeEffect)]
        let omitted: [(index: Int, effect: PrototypeEffect)]

        static let empty = Plan(drawn: [], omitted: [])

        static func == (lhs: Plan, rhs: Plan) -> Bool {
            lhs.drawn.map(\.index) == rhs.drawn.map(\.index) && lhs.omitted.map(\.index) == rhs.omitted.map(\.index)
                && lhs.drawn.map(\.effect) == rhs.drawn.map(\.effect)
        }

        var animated: Bool { drawn.contains { $0.effect.animated } }
    }

    /// `platformBackedSubtree` is evaluated only when an effect samples the node's pixels, because it
    /// walks the node's whole subtree.
    static func plan(_ raw: [JSONValue]?, platformBackedSubtree: @autoclosure () -> Bool) -> Plan {
        let parsed = parse(raw)
        guard !parsed.isEmpty else { return .empty }
        let omitted = parsed.contains { $0.effect.needsLayerSampling } && platformBackedSubtree()
            ? parsed.filter { $0.effect.needsLayerSampling } : []
        let omittedIndexes = Set(omitted.map(\.index))
        return Plan(drawn: parsed.filter { !omittedIndexes.contains($0.index) }, omitted: omitted)
    }

    /// Whether `node` is, or holds, a node SwiftUI backs with a platform view.
    static func hasPlatformBackedSubtree(_ node: PrototypeNode) -> Bool {
        if platformBackedTypes.contains(node.type) { return true }
        return nestedNodes(node).contains { $0.id != nil || hasPlatformBackedSubtree($0) }
    }

    private static func nestedNodes(_ node: PrototypeNode) -> [PrototypeNode] {
        (node.children ?? []) + [node.child].compactMap { $0 } + Array((node.screens ?? [:]).values)
    }

    /// Whether any style of `node` (its own or a `styleWhen` entry) authors effects, which is stable
    /// across state changes so the view keeps its identity when a `styleWhen` toggles them.
    static func authorsEffects(_ node: PrototypeNode) -> Bool {
        ([node.style] + (node.styleWhen ?? []).map(\.style)).contains { !($0?.effects ?? []).isEmpty }
    }

    /// `<node path>.style.effects[<authored index>]`, one form for every reason.
    static func path(_ nodePath: String, index: Int) -> String { "\(nodePath).style.effects[\(index)]" }

    /// Every effect on a visible node of the shown tree that this device cannot draw, shaped like
    /// Android's `degradedEffects` entries `{path, type, reason}`. A path is the node's position in the
    /// shown tree (`root`, `root.children[1]`, `root.child`, `root.screens["home"]`) plus the authored
    /// effect index, and follows the `styleWhen` style in force for `state`. `repeat` rows are already
    /// expanded in that tree, so a row has a plain `children[k]` path (Android's carries
    /// `repeat[<key>]`). Nodes whose `visibleWhen` fails and inactive stack screens are skipped, as on
    /// Android. `activeScreen` names a stack's top screen; a stack not in it shows its `start`. Entries
    /// are in tree order.
    static func degraded(
        root: PrototypeNode, state: [String: JSONValue], activeScreen: [String: String] = [:]
    )
        -> [[String: String]]
    {
        var found: [[String: String]] = []
        func visit(_ node: PrototypeNode, _ path: String) {
            if let visible = node.visibleWhen, !visible.holds(state) { return }
            let style = node.resolvedStyle(state: state)
            let plan = plan(style?.effects, platformBackedSubtree: hasPlatformBackedSubtree(node))
            for entry in plan.omitted {
                found.append([
                    "path": Self.path(path, index: entry.index), "type": entry.effect.type, "reason": platformReason,
                ])
            }
            if let child = node.child { visit(child, "\(path).child") }
            for (index, child) in (node.children ?? []).enumerated() {
                visit(child, "\(path).children[\(index)]")
            }
            guard let screens = node.screens else { return }
            let top = node.id.flatMap { activeScreen[$0] } ?? node.start
            if let top, let screen = screens[top] { visit(screen, "\(path).screens[\(quoted(top))]") }
        }
        visit(root, "root")
        return found
    }

    private static func quoted(_ name: String) -> String {
        let data = (try? JSONEncoder().encode(name)) ?? Data()
        return String(data: data, encoding: .utf8) ?? "\"\(name)\""
    }
}
