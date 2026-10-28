#if canImport(UIKit)
    import SwiftUI

    /// One path implementation for all style paints, including spread-adjusted shadow sources.
    struct PrototypeStyleShape: Shape {
        var radius: CornerRadius?
        let continuous: Bool
        var spread: Double = 0

        var animatableData: AnimatablePair<AnimatablePair<Double, Double>, AnimatablePair<Double, Double>> {
            get {
                switch radius {
                case let .uniform(value): return .init(.init(value, value), .init(value, value))
                case let .corners(topStart, topEnd, bottomEnd, bottomStart):
                    return .init(.init(topStart, topEnd), .init(bottomEnd, bottomStart))
                default: return .zero
                }
            }
            set {
                radius = .corners(
                    topStart: newValue.first.first,
                    topEnd: newValue.first.second,
                    bottomEnd: newValue.second.first,
                    bottomStart: newValue.second.second
                )
            }
        }

        func path(in rect: CGRect) -> Path {
            let radii = PrototypeStyleCorners.radii(radius, width: rect.width, height: rect.height, spread: spread)
            guard let bounds = PrototypeStyleCorners.sourceBounds(
                width: rect.width, height: rect.height, spread: spread
            ) else { return Path() }
            let box = bounds.offsetBy(dx: rect.minX, dy: rect.minY)
            return UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii(
                topLeading: radii[0], bottomLeading: radii[3], bottomTrailing: radii[2], topTrailing: radii[1]
            ), style: continuous ? .continuous : .circular).path(in: box)
        }
    }

    struct PrototypeStylePaintModifier: ViewModifier {
        let style: Style?
        let shape: PrototypeStyleShape
        let palette: PrototypePalette
        let clipsContent: Bool
        var styleAnimation: PrototypeStyleAnimation? = nil
        let shimmerAnimated: Bool
        var effects: PrototypeEffects.Plan = .empty
        var motion = PrototypeMotion(specMotion: nil, reduceMotion: false)
        var authorsEffects = false

        private var layers: [PrototypeStyleShadowLayer] {
            PrototypeStyleShadowLayer.resolve(style?.shadows, palette: palette)
        }

        func body(content: Content) -> some View {
            let background = styledBackground(content)
            let clipped = background
                .modifier(PrototypeShimmerModifier(
                    enabled: style?.shimmer == true, animated: shimmerAnimated, shape: shape
                ))
                .animation(styleAnimation?.animation("cornerRadius")) { view in
                    if clipsContent { view.clipShape(shape) } else { view }
                }
                .modifier(PrototypeEffectsModifier(
                    plan: effects, palette: palette, shape: shape, motion: motion, authored: authorsEffects
                ))
            let painted = clipped
                .overlay { border }
                .overlay { PrototypeStyleShadows(layers: layers, shape: shape, inner: true) }
                .background { PrototypeStyleShadows(layers: layers, shape: shape, inner: false) }
            let shadow: Color = style?.shadows == nil && (style?.elevation ?? 0) > 0
                ? palette.color(style?.shadowColor) ?? .black.opacity(0.25) : .clear
            let elevation = CGFloat(style?.elevation ?? 0)
            return painted.animation(styleAnimation?.animation("shadowColor")) { view in
                view.shadow(color: shadow, radius: elevation)
            }
        }

        @ViewBuilder
        private func styledBackground(_ content: Content) -> some View {
            if clipsContent {
                content
                    .background { PrototypeEffectMeshBackground(plan: effects, palette: palette) }
                    .background {
                        if let gradient = style?.gradient {
                            PrototypeGradientFill(gradient: gradient, palette: palette)
                        }
                    }
                    .animation(styleAnimation?.animation("background")) { view in
                        view.background(palette.color(style?.background) ?? .clear)
                    }
            } else {
                // Shape only the paints, preserving the card's own border, shadow and children.
                content
                    .background {
                        PrototypeEffectMeshBackground(plan: effects, palette: palette).clipShape(shape)
                    }
                    .background {
                        if let gradient = style?.gradient {
                            PrototypeGradientFill(gradient: gradient, palette: palette).clipShape(shape)
                        }
                    }
                    .animation(styleAnimation?.animation("background")) { view in
                        view.background(shape.fill(palette.color(style?.background) ?? .clear))
                    }
            }
        }

        @ViewBuilder private var border: some View {
            if let border = style?.border {
                if let gradient = border.gradient {
                    GeometryReader { proxy in
                        shape.stroke(
                            PrototypeGradientFill(gradient: gradient, palette: palette).paint(in: proxy.size),
                            lineWidth: border.width
                        )
                    }
                } else {
                    shape.stroke(style: StrokeStyle(lineWidth: border.width))
                        .animation(styleAnimation?.animation("border.color")) {
                            $0.foregroundStyle(palette.color(border.color) ?? .clear)
                        }
                        .animation(styleAnimation?.animation("border.width"), value: border.width)
                }
            }
        }
    }

    struct PrototypeStyleShadows: View {
        let layers: [PrototypeStyleShadowLayer]
        let shape: PrototypeStyleShape
        let inner: Bool

        var body: some View {
            if inner { canvas.clipShape(shape) } else { canvas }
        }

        private var canvas: some View {
            Canvas { context, size in
                let rect = CGRect(origin: .zero, size: size)
                for layer in layers where layer.inner == inner {
                    guard let color = layer.color else { continue }
                    var sourceShape = shape
                    sourceShape.spread = -layer.sourceInset
                    var path = sourceShape.path(in: rect)
                    if inner {
                        var inverse = Path(rect.insetBy(dx: -layer.inverseExtent, dy: -layer.inverseExtent))
                        inverse.addPath(path)
                        path = inverse
                    }
                    context.drawLayer { layerContext in
                        // A host ImageRenderer edge-profile check confirms SwiftUI View.shadow
                        // and GraphicsContext.shadow use sigma-like radius (r=10 matches sigma=10).
                        // CSS-like authored blur b therefore becomes b/2. shadowOnly prevents an
                        // opaque spread source from leaking through transparent node backgrounds.
                        layerContext.addFilter(.shadow(
                            color: Color(color), radius: layer.sigma,
                            x: layer.x, y: layer.y, options: .shadowOnly
                        ))
                        layerContext.fill(path, with: .color(.black), style: FillStyle(eoFill: inner))
                    }
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    struct PrototypeImageFilterModifier: ViewModifier {
        let parameters: PrototypeImageFilter

        func body(content: Content) -> some View {
            content.saturation(parameters.saturation)
                .colorMultiply(parameters.tint.map { Color($0) } ?? .white)
        }
    }

    private struct PrototypeScrollBoundsKey: PreferenceKey {
        static let defaultValue = CGRect.zero
        static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
    }

    /// iOS 17 geometry preferences track content relative to the viewport, including refresh scrolls.
    struct PrototypeFadingScroll<Content: View>: View {
        let axis: String?
        let spec: FadeEdges?
        @ViewBuilder let content: () -> Content
        @Environment(\.layoutDirection) private var direction
        @Namespace private var coordinateSpace
        @State private var bounds = CGRect.zero

        var body: some View {
            ScrollView(axis == "horizontal" ? .horizontal : .vertical) {
                content().background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: PrototypeScrollBoundsKey.self,
                            value: proxy.frame(in: .named(coordinateSpace))
                        )
                    }
                }
            }
            .coordinateSpace(name: coordinateSpace)
            .onPreferenceChange(PrototypeScrollBoundsKey.self) { bounds = $0 }
            .mask {
                GeometryReader { proxy in
                    let horizontal = axis == "horizontal"
                    let available = PrototypeFadeEdges.scrollability(
                        min: horizontal ? bounds.minX : bounds.minY,
                        max: horizontal ? bounds.maxX : bounds.maxY,
                        viewport: horizontal ? proxy.size.width : proxy.size.height,
                        horizontal: horizontal, rightToLeft: direction == .rightToLeft
                    )
                    let fades = PrototypeFadeEdges.resolve(
                        axis: axis, rightToLeft: direction == .rightToLeft,
                        canScrollBackward: available.backward, canScrollForward: available.forward, spec: spec
                    )
                    // Multiplying independent masks preserves both fades when both edges can scroll.
                    Rectangle().fill(.white).mask {
                        fade(fades.first, size: proxy.size).mask { fade(fades.dropFirst().first, size: proxy.size) }
                    }
                }
            }
        }

        @ViewBuilder
        private func fade(_ fade: PrototypeFadeEdges.Fade?, size: CGSize) -> some View {
            if let fade {
                let horizontal = fade.edge == .left || fade.edge == .right
                let fraction = PrototypeFadeEdges.fraction(
                    distance: fade.length,
                    length: horizontal ? size.width : size.height
                )
                let reversed = fade.edge == .bottom || fade.edge == .right
                // Physical UnitPoints avoid a second automatic leading/trailing flip in RTL.
                LinearGradient(
                    stops: [
                        .init(color: reversed ? .white : .clear, location: 0),
                        .init(color: .white, location: reversed ? 1 - fraction : fraction),
                        .init(color: reversed ? .clear : .white, location: 1),
                    ],
                    startPoint: UnitPoint(x: 0, y: 0),
                    endPoint: UnitPoint(x: horizontal ? 1 : 0, y: horizontal ? 0 : 1)
                )
                .environment(\.layoutDirection, .leftToRight)
            } else {
                Color.white
            }
        }
    }
#endif
