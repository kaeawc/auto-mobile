import SwiftUI

/// Draws anchored nodes above the content below it, at window level (#9316, #10803). Drawn inside
/// their parents, a wrap-content parent would reserve a slot for them and clip them to it. The layer
/// takes the whole area it is given and places each node at its anchor's screen rectangle less the
/// layer's own screen origin (the window's screen origin plus the layer's position in the window,
/// which is below the dismiss bar for a fullscreen overlay), so its touch target and accessibility
/// frame are where it is drawn. Only the window and the content area clip it.
struct OverlayAnchorLayer: View {
    /// A `sheet` placement's edge and height: the layer draws and takes touches only inside that
    /// strip of the window, as Android clips everything outside a sheet window (#10912).
    struct Sheet: Equatable {
        let edge: String?
        let height: Double?
        /// Points the keyboard raises a bottom sheet; the clip and anchors move with it.
        var lift: Double = 0
    }

    let entries: [OverlayAnchoredNode]
    @ObservedObject var model: OverlayModel
    var sheet: Sheet?
    @Environment(\.layoutDirection) private var direction
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if !entries.isEmpty {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                let region = sheet.map {
                    OverlaySheetFrame.rect(
                        containerWidth: frame.width, containerHeight: frame.height,
                        edge: $0.edge, height: $0.height, lift: $0.lift
                    )
                } ?? OverlayRect(x: 0, y: 0, width: frame.width, height: frame.height)
                let clip = sheet == nil ? nil : CGRect(
                    x: frame.minX + region.x, y: frame.minY + region.y, width: region.width, height: region.height
                )
                let origin = CGPoint(
                    x: model.windowOrigin.x + frame.minX + region.x,
                    y: model.windowOrigin.y + frame.minY + region.y
                )
                let content = ZStack(alignment: .topLeading) {
                    ForEach(entries, id: \.path) { entry in
                        anchored(entry, layerOrigin: origin, clip: clip)
                    }
                }
                .frame(width: region.width, height: region.height, alignment: .topLeading)
                if sheet == nil {
                    content
                } else {
                    content
                        .clipped()
                        .offset(x: region.x, y: region.y)
                        .frame(width: frame.width, height: frame.height, alignment: .topLeading)
                }
            }
            // Positions are screen coordinates; start and end are resolved from `direction` instead.
            .environment(\.layoutDirection, .leftToRight)
        }
    }

    /// The anchored node fades with the ancestor that hides it (Android's #10897): it stays drawn
    /// through that ancestor's exit, its opacity driven by the same 0.25 s ease, and stops taking
    /// touches and reading to accessibility the moment the ancestor hides.
    private func anchored(_ entry: OverlayAnchoredNode, layerOrigin: CGPoint, clip: CGRect?) -> some View {
        let cover = entry.anchor.covers
            ? entry.anchor.bounds.map { CGSize(width: $0.width, height: $0.height) }
            : nil
        let fade = OverlayMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).containerSizeDuration
        return OverlayAnchorPlacement(
            anchor: entry.anchor,
            layerOrigin: layerOrigin,
            rightToLeft: direction == .rightToLeft
        ) {
            NodeView(node: entry.node, model: model, anchorPlaced: true, coverSize: cover)
                .environment(\.layoutDirection, direction)
                .reportFrame(key: "anchor.\(entry.path)", model: model, clip: clip, enabled: entry.ancestorsShown)
        }
        .opacity(entry.ancestorsShown ? 1 : 0)
        .animation(fade.map { .easeInOut(duration: $0) }, value: entry.ancestorsShown)
        .allowsHitTesting(entry.ancestorsShown)
        .accessibilityHidden(!entry.ancestorsShown)
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
