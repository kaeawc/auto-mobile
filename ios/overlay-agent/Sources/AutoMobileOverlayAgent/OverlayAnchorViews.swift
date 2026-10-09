import SwiftUI

/// Draws anchored nodes above the content below it, at window level (#9316, #10803). Drawn inside
/// their parents, a wrap-content parent would reserve a slot for them and clip them to it. The layer
/// takes the whole area it is given and places each node at its anchor's screen rectangle less the
/// layer's own screen origin (the window's screen origin plus the layer's position in the window,
/// which is below the dismiss bar for a fullscreen overlay), so its touch target and accessibility
/// frame are where it is drawn. Only the window and the content area clip it.
struct OverlayAnchorLayer: View {
    let entries: [OverlayAnchoredNode]
    @ObservedObject var model: OverlayModel
    @Environment(\.layoutDirection) private var direction

    var body: some View {
        if !entries.isEmpty {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                ZStack(alignment: .topLeading) {
                    ForEach(entries, id: \.path) { entry in
                        anchored(entry, layerOrigin: CGPoint(
                            x: model.windowOrigin.x + frame.minX,
                            y: model.windowOrigin.y + frame.minY
                        ))
                    }
                }
                .frame(width: frame.width, height: frame.height, alignment: .topLeading)
            }
            // Positions are screen coordinates; start and end are resolved from `direction` instead.
            .environment(\.layoutDirection, .leftToRight)
        }
    }

    private func anchored(_ entry: OverlayAnchoredNode, layerOrigin: CGPoint) -> some View {
        let cover = entry.anchor.covers
            ? entry.anchor.bounds.map { CGSize(width: $0.width, height: $0.height) }
            : nil
        return OverlayAnchorPlacement(
            anchor: entry.anchor,
            layerOrigin: layerOrigin,
            rightToLeft: direction == .rightToLeft
        ) {
            NodeView(node: entry.node, model: model, anchorPlaced: true, coverSize: cover)
                .environment(\.layoutDirection, direction)
                .reportFrame(key: "anchor.\(entry.path)", model: model)
        }
    }
}

/// Places its one subview at the anchor's rectangle in the layer's space. A cover anchor proposes
/// the bounds' size; an edge anchor measures the node against the whole layer, as Android measures
/// it against the whole overlay content.
private struct OverlayAnchorPlacement: Layout {
    let anchor: OverlayAnchor
    let layerOrigin: CGPoint
    let rightToLeft: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews _: Subviews, cache _: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        for subview in subviews {
            let size = anchor.covers
                ? CGSize(width: anchor.bounds?.width ?? 0, height: anchor.bounds?.height ?? 0)
                : subview.sizeThatFits(ProposedViewSize(bounds.size))
            guard let rect = anchor.layerRect(
                nodeWidth: size.width,
                nodeHeight: size.height,
                rightToLeft: rightToLeft,
                layerOriginX: layerOrigin.x,
                layerOriginY: layerOrigin.y
            ) else { continue }
            subview.place(
                at: CGPoint(x: bounds.minX + rect.x, y: bounds.minY + rect.y),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: rect.width, height: rect.height)
            )
        }
    }
}
