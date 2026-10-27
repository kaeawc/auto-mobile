#if canImport(UIKit)
    import SwiftUI

    /// The precompiled effect presets (`Shaders/PrototypeEffects.metal`), embedded as bytes by
    /// `scripts/ios/prototype-effects-metallib.sh` because the dylib has no bundle. Nil only if the
    /// embedded bytes are unreadable, in which case every shader-backed effect is simply not drawn.
    enum PrototypeEffectsLibrary {
        static let library: ShaderLibrary? = Data(base64Encoded: PrototypeEffectsMetallib.base64)
            .flatMap { $0.isEmpty ? nil : ShaderLibrary(data: $0) }
    }

    /// `style.effects` (#15130) on one node, as Android's `PrototypeEffectsContent`: shader distortions
    /// wrap the node's background and content (after its corner clip), `shimmer`, `glow`, `vignette`
    /// and `noise` paint over the content inside the corner shape and are not distorted, and
    /// `gradientMesh` is a background (see `PrototypeEffectMeshBackground`). Effects are paint only:
    /// they never change layout, hit testing or accessibility.
    struct PrototypeEffectsModifier: ViewModifier {
        let plan: PrototypeEffects.Plan
        let palette: PrototypePalette
        let shape: PrototypeStyleShape
        let motion: PrototypeMotion
        /// Whether any style of the node authors effects: stable across `styleWhen` changes, so the
        /// subtree keeps its identity (and its focus and scroll state) when a state toggles them.
        let authored: Bool

        /// When the animation began; an animated effect starts at its authored `phase` each time the
        /// clock starts running.
        @State private var started: Date?

        func body(content: Content) -> some View {
            if !authored {
                content
            } else {
                let running = plan.animated && PrototypeEffects.runs(motion)
                // `paused` holds the authored `phase` under `motion: "none"`, Reduce Motion and while
                // nothing animates, so screenshots and observe are deterministic.
                TimelineView(.animation(paused: !running)) { timeline in
                    let clock = running ? timeline.date.timeIntervalSince(started ?? timeline.date) : 0
                    layered(content, clock: clock)
                }
                .onChange(of: running, initial: true) { _, isRunning in started = isRunning ? Date() : nil }
            }
        }

        private func layered(_ content: Content, clock: TimeInterval) -> some View {
            distorted(AnyView(content), clock: clock)
                // A blur or displacement must not bleed past the node.
                .clipped()
                .overlay {
                    ZStack {
                        ForEach(painted, id: \.index) { entry in
                            PrototypePaintedEffect(effect: entry.effect, palette: palette, clock: clock)
                        }
                    }
                    .clipShape(shape)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
        }

        private var painted: [(index: Int, effect: PrototypeEffect)] {
            plan.drawn.filter {
                switch $0.effect.look {
                case .shimmer, .glow, .vignette, .noise: true
                default: false
                }
            }
        }

        private func distorted(_ view: AnyView, clock: TimeInterval) -> AnyView {
            plan.drawn.reduce(view) { current, entry in
                let phase = PrototypeEffects.phase(of: entry.effect, elapsed: clock)
                return PrototypeEffectDistortion.apply(entry.effect, phase: phase, to: current)
            }
        }
    }

    /// The distortions in authored order: each later one sees the result of the earlier.
    enum PrototypeEffectDistortion {
        static func apply(_ effect: PrototypeEffect, phase: Double, to view: AnyView) -> AnyView {
            let library = PrototypeEffectsLibrary.library
            switch effect.look {
            case let .blur(radius):
                return radius > 0 ? AnyView(view.blur(radius: radius)) : view
            case let .pixelate(cell):
                guard let library else { return view }
                let size = max(cell, 1)
                return AnyView(view.layerEffect(
                    library.pixelate(.float(size)), maxSampleOffset: CGSize(width: size, height: size)
                ))
            case let .chromaticAberration(offset, angle):
                guard let library else { return view }
                let direction = PrototypeEffects.direction(degrees: angle)
                return AnyView(view.layerEffect(
                    library.chromaticAberration(.float2(direction.x * offset, direction.y * offset)),
                    maxSampleOffset: CGSize(width: offset, height: offset)
                ))
            case let .wave(amplitude, wavelength, angle):
                guard let library else { return view }
                let direction = PrototypeEffects.direction(degrees: angle)
                return AnyView(view.distortionEffect(
                    library.wave(
                        .float2(direction.x, direction.y), .float(amplitude), .float(max(wavelength, 1)),
                        .float(phase * 2 * .pi)
                    ),
                    maxSampleOffset: CGSize(width: amplitude, height: amplitude)
                ))
            case let .ripple(amplitude, wavelength, centerX, centerY):
                guard let library else { return view }
                return AnyView(view.distortionEffect(
                    library.ripple(
                        .boundingRect, .float2(centerX, centerY), .float(amplitude), .float(max(wavelength, 1)),
                        .float(phase * 2 * .pi)
                    ),
                    maxSampleOffset: CGSize(width: amplitude, height: amplitude)
                ))
            default:
                return view
            }
        }
    }

    /// One over-the-content effect: shimmer, glow, vignette or noise.
    private struct PrototypePaintedEffect: View {
        let effect: PrototypeEffect
        let palette: PrototypePalette
        let clock: TimeInterval

        /// A shimmer band never exceeds this opacity; with no colour it is white at `defaultShimmerAlpha`.
        private static let maxShimmerAlpha = 0.5
        private static let defaultShimmerAlpha = 0.35

        var body: some View {
            switch effect.look {
            case let .shimmer(color, angle, width): shimmer(color: color, angle: angle, width: width)
            case let .glow(color, radius, intensity): glow(color: color, radius: radius, intensity: intensity)
            case let .vignette(color, intensity, radius): vignette(color: color, intensity: intensity, radius: radius)
            case let .noise(amount, grain, seed, monochrome):
                noise(amount: amount, grain: grain, seed: seed, monochrome: monochrome)
            default: EmptyView()
            }
        }

        private func shimmer(color: PrototypeModeValue?, angle: Double, width: Double) -> some View {
            let base = color.flatMap { palette.color($0) } ?? Color.white.opacity(Self.defaultShimmerAlpha)
            let peak = base.opacity(min(base.rgbaAlpha, Self.maxShimmerAlpha) / max(base.rgbaAlpha, 0.0001))
            let phase = PrototypeEffects.phase(of: effect, elapsed: clock)
            // The band's centre travels from one half-width before the start to one after the end.
            let half = width / 2
            let centre = -half + phase * (1 + width)
            func clamp(_ value: Double) -> CGFloat { CGFloat(min(max(value, 0), 1)) }
            return GeometryReader { proxy in
                let line = PrototypeGradient.linearLine(
                    angle: angle, width: Double(proxy.size.width), height: Double(proxy.size.height)
                )
                Rectangle().fill(LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .clear, location: clamp(centre - half)),
                        .init(color: peak, location: clamp(centre)),
                        .init(color: .clear, location: clamp(centre + half)),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: UnitPoint(x: line.start.x, y: line.start.y),
                    endPoint: UnitPoint(x: line.end.x, y: line.end.y)
                ))
            }
        }

        /// An inward edge glow: a wide blurred stroke along the border, clipped to the node.
        private func glow(color: PrototypeModeValue, radius: Double, intensity: Double) -> some View {
            let tint = palette.color(color) ?? .clear
            return Rectangle()
                .strokeBorder(tint.opacity(intensity), lineWidth: radius)
                .blur(radius: radius / 2)
        }

        private func vignette(color: PrototypeModeValue?, intensity: Double, radius: Double) -> some View {
            let base = color.flatMap { palette.color($0) } ?? .black
            return GeometryReader { proxy in
                let reach = (proxy.size.width * proxy.size.width + proxy.size.height * proxy.size.height)
                    .squareRoot() / 2
                Rectangle().fill(RadialGradient(
                    stops: [
                        .init(color: .clear, location: CGFloat(min(max(radius, 0), 1))),
                        .init(color: base.opacity(intensity), location: 1),
                    ],
                    center: .center, startRadius: 0, endRadius: reach
                ))
            }
        }

        @ViewBuilder
        private func noise(amount: Double, grain: Double, seed: Int, monochrome: Bool) -> some View {
            if let library = PrototypeEffectsLibrary.library {
                let offset = PrototypeEffects.noiseSeedOffset(seed)
                Rectangle().fill(library.noise(
                    .float(max(grain, 0.5)), .float(amount), .float2(offset.x, offset.y), .float(monochrome ? 1 : 0)
                ))
            }
        }
    }

    /// The `gradientMesh` fill, between the node's background and its content.
    struct PrototypeEffectMeshBackground: View {
        let plan: PrototypeEffects.Plan
        let palette: PrototypePalette

        var body: some View {
            ZStack {
                ForEach(meshes, id: \.index) { mesh in
                    if let library = PrototypeEffectsLibrary.library {
                        let colors = mesh.colors.map { palette.color($0) ?? .clear }
                        Rectangle().fill(library.gradientMesh(
                            .boundingRect, .float(mesh.softness),
                            .color(colors[0]), .color(colors[1]), .color(colors[2]), .color(colors[3])
                        ))
                    }
                }
            }
            .accessibilityHidden(true)
        }

        private var meshes: [(index: Int, colors: [PrototypeModeValue], softness: Double)] {
            plan.drawn.compactMap { entry in
                if case let .gradientMesh(colors, softness) = entry.effect.look {
                    return (entry.index, colors, softness)
                }
                return nil
            }
        }
    }

    extension Color {
        /// The alpha a colour was authored with; 1 for an opaque colour.
        fileprivate var rgbaAlpha: Double {
            var alpha: CGFloat = 1
            UIColor(self).getRed(nil, green: nil, blue: nil, alpha: &alpha)
            return Double(alpha)
        }
    }
#endif
