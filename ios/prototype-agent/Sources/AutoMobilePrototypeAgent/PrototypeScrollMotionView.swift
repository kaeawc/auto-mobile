#if canImport(UIKit)
    import SwiftUI

    private struct PrototypeScrollOffsetPreference: PreferenceKey {
        static let defaultValue: [ObjectIdentifier: Double] = [:]
        static func reduce(value: inout [ObjectIdentifier: Double], nextValue: () -> [ObjectIdentifier: Double]) {
            value.merge(
                nextValue(),
                uniquingKeysWith: { _, new in new }
            )
        }
    }

    /// Geometry preferences keep the iOS 17 floor; points match authored dp on every iOS version.
    @MainActor
    struct PrototypeMotionScroll: View {
        let node: PrototypeNode
        let model: PrototypeModel
        private var coordinate: ObjectIdentifier { ObjectIdentifier(node) }
        var body: some View {
            PrototypeFadingScroll(axis: node.axis, spec: node.fadeEdges) {
                if let child = node.child {
                    NodeView(node: child, model: model)
                        .background(GeometryReader { geometry in
                            let origin = geometry.frame(in: .named(coordinate)).origin
                            Color.clear.preference(
                                key: PrototypeScrollOffsetPreference.self,
                                value: [coordinate: -Double(node.axis == "horizontal" ? origin.x : origin.y)]
                            )
                        })
                }
            }
            .coordinateSpace(name: coordinate)
            .onPreferenceChange(PrototypeScrollOffsetPreference.self) { offsets in
                if let offset = offsets[coordinate] { model.scrollOffsets[coordinate] = max(0, offset) }
            }
        }
    }

    @MainActor
    struct PrototypeScrollMotionModifier: ViewModifier {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        func body(content: Content) -> some View {
            let edge = node.scrollTransition?.edge
            let linked = node.scrollLinked
            let reduced = model.spec?.motion == "reduced" || (reduceMotion && model.spec?.motion != "none")
            let offset = model.scrollOffset(for: node)
            let draw = PrototypeScrollMotion.draw(linked, offset: offset, reduced: reduced)
            if linked == nil, node.scrollTransition == nil {
                content
            } else {
                content
                    .visualEffect { effect, _ in
                        effect.opacity(draw.alpha)
                            .scaleEffect(draw.scale)
                            .offset(
                                x: draw.offsetX,
                                y: draw.offsetY
                            )
                            .blur(radius: draw.blur)
                    }
                    .scrollTransition(
                        .interactive(timingCurve: .linear).threshold(.centered),
                        axis: node.scrollTransition?.axis == "horizontal" ? .horizontal : .vertical
                    ) { effect, phase in
                        effect.opacity(PrototypeScrollMotion.edge(
                            phase.value,
                            value: edge?.alpha ?? 1,
                            identity: 1
                        ))
                        .scaleEffect(reduced ? 1 : PrototypeScrollMotion.edge(
                            phase.value,
                            value: edge?.scale ?? 1,
                            identity: 1
                        ))
                        .rotationEffect(.degrees(reduced ? 0 : PrototypeScrollMotion.edge(
                            phase.value,
                            value: edge?.rotation ?? 0,
                            identity: 0
                        )))
                    }
            }
        }
    }
#endif
