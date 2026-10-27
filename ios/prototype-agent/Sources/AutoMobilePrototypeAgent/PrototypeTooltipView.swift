#if canImport(UIKit)
    import SwiftUI

    /// Both the bubble and the spotlight live in the top host; only their actual hit areas are reported.
    @MainActor
    struct PrototypeTooltipOverlay: View {
        let node: PrototypeNode
        let model: PrototypeModel
        let hitKey: String
        @Environment(\.prototypePalette) private var palette
        @Environment(\.layoutDirection) private var direction
        @State private var size = CGSize(width: 200, height: 48)
        @State private var focus = PrototypeOverlayFocusAnchor()

        private var targetNode: PrototypeNode? {
            guard let id = node.anchorTo else { return nil }
            return model.spec?.root.renderedNode(id: id, state: model.state, pages: model.pages, stacks: model.stacks)
        }

        private var targetBounds: CGRect? {
            if let targetNode { return model.menuBounds[ObjectIdentifier(targetNode)] }
            guard node.anchorTo == nil, let anchor = node.anchor, let rect = anchor.bounds else { return nil }
            return CGRect(
                x: rect.x + anchor.offsetX,
                y: rect.y + anchor.offsetY,
                width: rect.width,
                height: rect.height
            )
        }

        var body: some View {
            GeometryReader { proxy in
                if let targetBounds {
                    let global = proxy.frame(in: .global)
                    let target = targetBounds.offsetBy(dx: -global.minX, dy: -global.minY)
                    let placement = PrototypePlacement.place(
                        target: target, bubble: size, window: CGRect(origin: .zero, size: proxy.size),
                        rightToLeft: direction == .rightToLeft, caret: node.caret ?? .auto
                    )
                    ZStack(alignment: .topLeading) {
                        if let spotlight = node.spotlight {
                            spotlightLayer(target: target, spotlight: spotlight)
                        }
                        NodeView(node: node, model: model, presentedAsModal: true)
                            .environment(\.layoutDirection, direction)
                            .overlay {
                                PrototypeTooltipCaret(placement: placement, rightToLeft: direction == .rightToLeft)
                                    .fill(ComponentColors(palette: palette).inverseSurface)
                                    .accessibilityHidden(true)
                                    .allowsHitTesting(false)
                            }
                            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
                            .contentShape(Rectangle())
                            .onTapGesture { model.activate(.node(node)) }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(interpolatePrototypeText(
                                node.text ?? "",
                                state: model.state,
                                pager: nil
                            ))
                            .accessibilityHint("Tooltip")
                            .prototypeIdentifier(node.identifier)
                            .background(PrototypeOverlayFocusMarker(anchor: focus))
                            .reportFrame(key: hitKey, model: model)
                            .offset(x: placement.origin.x, y: placement.origin.y)
                            .onAppear { if node.spotlight != nil { focus.enter() } }
                            .onDisappear {
                                if node
                                    .spotlight !=
                                    nil { focus.restore(target: targetNode.map { model.focusAnchor(for: $0) }) }
                            }
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                    .environment(\.layoutDirection, .leftToRight)
                }
            }
        }

        private func spotlightLayer(target: CGRect, spotlight: TooltipSpotlight) -> some View {
            PrototypeSpotlightShape(
                hole: PrototypeTooltips.spotlightRect(target: target, spotlight: spotlight),
                radius: CGFloat(spotlight.cornerRadius ?? 12)
            )
            .fill(palette.sheetScrim(nil).map { Color($0) } ?? .black.opacity(0.4), style: FillStyle(eoFill: true))
            .contentShape(Rectangle())
            .onTapGesture { model.closeModal(node) }
            .accessibilityLabel("Dismiss tooltip")
            .accessibilityAddTraits(.isButton)
            .prototypeIdentifier(node.partIdentifier("close"))
            .reportFrame(key: hitKey + ".scrim", model: model)
        }
    }

    @MainActor
    struct PrototypeTooltipBubble: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.prototypePalette) private var palette

        var body: some View {
            Text(interpolatePrototypeText(node.text ?? "", state: model.state, pager: nil))
                .font(.body)
                .foregroundStyle(ComponentColors(palette: palette).inverseOnSurface)
                .padding(12)
                .frame(maxWidth: 280)
                .fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 12).fill(ComponentColors(palette: palette).inverseSurface))
        }
    }

    private struct PrototypeSpotlightShape: Shape {
        let hole: CGRect
        let radius: CGFloat
        func path(in rect: CGRect) -> Path {
            var path = Path(rect)
            path.addRoundedRect(in: hole, cornerSize: CGSize(width: radius, height: radius))
            return path
        }
    }

    private struct PrototypeTooltipCaret: Shape {
        let placement: PrototypePlacement
        let rightToLeft: Bool
        func path(in rect: CGRect) -> Path {
            let offset = placement.caretOffset
            let top = placement.caret == .top
            let vertical = top || placement.caret == .bottom
            let left = (placement.caret == .start) != rightToLeft
            let base = vertical ? CGPoint(x: offset, y: top ? 0 : rect.height) :
                CGPoint(x: left ? 0 : rect.width, y: offset)
            let points: [CGPoint] = vertical ? [
                CGPoint(x: base.x - 6, y: base.y), CGPoint(x: base.x, y: base.y + (top ? -8 : 8)),
                CGPoint(x: base.x + 6, y: base.y),
            ] : [
                CGPoint(x: base.x, y: base.y - 6), CGPoint(x: base.x + (left ? -8 : 8), y: base.y),
                CGPoint(x: base.x, y: base.y + 6),
            ]
            return Path { path in
                path.addLines(points)
                path.closeSubpath()
            }
        }
    }
#endif
