#if canImport(UIKit)
    import SwiftUI

    /// Namespaced geometry keeps nested scrolls from reporting another scroll's edges.
    private struct PrototypeScrollGeometry: PreferenceKey {
        static let defaultValue: [Namespace.ID: [String: Double]] = [:]
        static func reduce(
            value: inout [Namespace.ID: [String: Double]],
            nextValue: () -> [Namespace.ID: [String: Double]]
        ) {
            value.merge(nextValue(), uniquingKeysWith: { current, next in
                current.merging(next, uniquingKeysWith: { _, next in next })
            })
        }
    }

    @MainActor
    struct PrototypeChatScrollView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Namespace private var space
        @State private var edges = PrototypeChatScroll()
        @State private var handledSequence: Int?
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        private var request: PrototypeScrollRequest? { node.id.flatMap { model.scrollRequests[$0] } }
        private var vertical: Bool { node.axis != "horizontal" }

        var body: some View {
            ScrollViewReader { proxy in
                anchoredScroll
                    .coordinateSpace(name: space)
                    .background {
                        GeometryReader { geometry in
                            Color.clear.preference(key: PrototypeScrollGeometry.self, value: [space: [
                                "viewport": vertical ? geometry.size.height : geometry.size.width,
                            ]])
                        }
                    }
                    .onPreferenceChange(PrototypeScrollGeometry.self) { geometry in
                        guard let geometry = geometry[space], let start = geometry["start"], let end = geometry["end"],
                              let viewport = geometry["viewport"], viewport > 0 else { return }
                        if vertical {
                            let effects = edges.update(
                                start: start, end: end, viewport: viewport, stickToEnd: node.stickToEnd == true
                            )
                            if effects.followEnd { proxy.scrollTo(PrototypeScrollTarget.end, anchor: .bottom) }
                            model.scrollEdges(node, atEnd: effects.atEnd, reachedStart: effects.reachedStart)
                        }
                    }
                    .onChange(of: request, initial: true) { _, pending in
                        guard let pending, handledSequence != pending.sequence else { return }
                        handledSequence = pending.sequence
                        let anchor: UnitPoint = pending.target == .end ? (vertical ? .bottom : .trailing) :
                            (vertical ? .top : .leading)
                        if pending.animated, !reduceMotion {
                            withAnimation { proxy.scrollTo(pending.target, anchor: anchor) }
                        } else {
                            proxy.scrollTo(pending.target, anchor: anchor)
                        }
                    }
            }
        }

        @ViewBuilder private var anchoredScroll: some View {
            if #available(iOS 18, *) {
                scroll
                    .defaultScrollAnchor(vertical ? (node.reverse == true ? .bottom : .top) : nil, for: .initialOffset)
                    // The geometry follow keeps a reader who scrolled away in place.
                    .defaultScrollAnchor(
                        node.stickToEnd == true && edges.atEnd == true ? .bottom : nil,
                        for: .sizeChanges
                    )
            } else {
                scroll.defaultScrollAnchor(vertical ? (node.reverse == true ? .bottom : .top) : nil)
            }
        }

        private var scroll: some View {
            ScrollView(vertical ? .vertical : .horizontal) {
                if vertical {
                    VStack(spacing: 0) {
                        sentinel(.start)
                        if let child = node.child { NodeView(node: child, model: model) }
                        sentinel(.end)
                    }
                } else {
                    HStack(spacing: 0) {
                        sentinel(.start)
                        if let child = node.child { NodeView(node: child, model: model) }
                        sentinel(.end)
                    }
                }
            }
        }

        private func sentinel(_ target: PrototypeScrollTarget) -> some View {
            Color.clear
                .frame(width: 0, height: 0)
                .background {
                    GeometryReader { geometry in
                        let frame = geometry.frame(in: .named(space))
                        Color.clear.preference(key: PrototypeScrollGeometry.self, value: [space: [
                            target == .start ? "start" : "end": vertical ? frame.minY : frame.minX,
                        ]])
                    }
                }
                .id(target)
                .accessibilityHidden(true)
        }
    }
#endif
