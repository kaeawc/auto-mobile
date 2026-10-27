#if canImport(UIKit)
    import SwiftUI

    private struct PrototypeBarOffsetKey: PreferenceKey {
        static let defaultValue: [ObjectIdentifier: Double] = [:]
        static func reduce(value: inout [ObjectIdentifier: Double], nextValue: () -> [ObjectIdentifier: Double]) {
            value.merge(nextValue(), uniquingKeysWith: { _, next in next })
        }
    }

    /// Uses a named viewport on iOS 17 as well as newer systems; no native toolbar paths.
    struct PrototypeBarScrollContent<Content: View>: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @ViewBuilder let content: () -> Content
        var body: some View {
            content()
                .background(GeometryReader { geometry in
                    Color.clear.preference(
                        key: PrototypeBarOffsetKey.self,
                        value: [ObjectIdentifier(node): -geometry.frame(in: .named(ObjectIdentifier(node))).minY]
                    )
                })
                .onPreferenceChange(PrototypeBarOffsetKey.self) { offsets in
                    if let offset = offsets[ObjectIdentifier(node)] { model.updateBarScroll(node, offset: offset) }
                }
        }
    }

    /// Translate the clipped bar down while retaining its bottom edge. Applied after node semantics
    /// so its accessibility frame moves with the pixels.
    struct PrototypeBarSlide: ViewModifier {
        let fraction: Double
        @State private var drawnHeight = 0.0
        func body(content: Content) -> some View {
            content
                .background(GeometryReader { geometry in
                    Color.clear
                        .onAppear { drawnHeight = geometry.size.height }
                        .onChange(of: geometry.size.height) { _, height in drawnHeight = height }
                })
                .offset(y: fraction < 1 ? drawnHeight * fraction / (1 - fraction) : 0)
        }
    }

    struct PrototypeBarClip: ViewModifier {
        let fraction: Double
        func body(content: Content) -> some View {
            PrototypeBarClipLayout(fraction: fraction) { content }
                .clipped()
                .allowsHitTesting(fraction < 1)
                .accessibilityHidden(fraction >= 1)
        }
    }

    private struct PrototypeBarClipLayout: Layout {
        let fraction: Double
        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
            let size = subviews.first?.sizeThatFits(proposal) ?? .zero
            return CGSize(width: size.width, height: size.height * (1 - fraction))
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
            subviews.first?.place(at: CGPoint(x: bounds.minX, y: bounds.minY), anchor: .topLeading, proposal: proposal)
        }
    }

    extension PrototypeModel {
        func updateBarScroll(_ node: PrototypeNode, offset: Double) {
            guard let id = node.id, let root = spec?.root else { return }
            func screen(_ node: PrototypeNode) -> [PrototypeNode] {
                [node] + (node.child.map { screen($0) } ?? []) + (node.children ?? []).flatMap { screen($0) }
            }
            func find(_ root: PrototypeNode) -> [PrototypeNode]? {
                let nodes = screen(root)
                if nodes.contains(where: { $0 === node }) { return nodes }
                for candidate in nodes {
                    for child in candidate.screens?.values ?? [:].values {
                        if let result = find(child) { return result }
                    }
                }
                return nil
            }
            for bar in find(root) ?? []
                where ["topAppBar", "bottomNav", "tabBar"].contains(bar.type) && bar.scroll == id
            {
                let key = ObjectIdentifier(bar)
                var state = barScrollStates[key] ?? PrototypeBarScrollState()
                let extent = PrototypeBarScrollState.extent(variant: bar.variant, behavior: bar.onScroll)
                state.update(offset: offset, extent: extent)
                if state != barScrollStates[key] { barScrollStates[key] = state }
            }
        }

        func barScroll(_ bar: PrototypeNode) -> PrototypeBarScrollState {
            barScrollStates[ObjectIdentifier(bar)] ?? PrototypeBarScrollState()
        }
    }
#endif
