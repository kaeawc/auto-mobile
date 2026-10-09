import SwiftUI

/// Children layered like a `ZStack`, each placed with the proposal its parent made rather than
/// at the size the stack measured; on an axis that fills, it takes the whole proposal like
/// `frame(maxWidth: .infinity)`.
///
/// A `ZStack`, and a `frame(maxWidth: nil, maxHeight: nil)`, both measure their child and then
/// place it with that measured size as the proposal. An `HStack` proposed exactly its ideal width
/// shares it out evenly by flexibility, so in `[text "Cancel", outlined "Edit", filled "Save"]`
/// the wider labels got less than they measured and drew as "Edi" and "Sav" (#10899). Every node
/// wrapper that sits between a row and its parent (the size frame, the conditional container, a
/// box) uses this instead, so a row is laid out exactly as it was measured.
struct OverlayLayeredLayout: Layout {
    var fillsWidth = false
    var fillsHeight = false
    let alignment: Alignment

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(proposal) }
        let width = sizes.map(\.width).max() ?? 0
        let height = sizes.map(\.height).max() ?? 0
        return CGSize(
            width: fillsWidth ? Self.filled(proposal.width, width) : width,
            height: fillsHeight ? Self.filled(proposal.height, height) : height
        )
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        let anchor = Self.anchor(alignment)
        for child in subviews {
            // A parent that gives less than was measured (a squeezed row) still bounds the child.
            let measured = child.sizeThatFits(proposal)
            let childProposal = ProposedViewSize(
                width: fillsWidth || bounds.width < measured.width ? bounds.width : proposal.width,
                height: fillsHeight || bounds.height < measured.height ? bounds.height : proposal.height
            )
            child.place(
                at: CGPoint(x: bounds.minX + bounds.width * anchor.x, y: bounds.minY + bounds.height * anchor.y),
                anchor: anchor,
                proposal: childProposal
            )
        }
    }

    /// The whole proposal on a filling axis, unbounded included (so a parent stack sees the node
    /// as greedy, as with `frame(maxWidth: .infinity)`); the children's size under an ideal one.
    private static func filled(_ proposed: CGFloat?, _ content: CGFloat) -> CGFloat {
        guard let proposed else { return content }
        return Swift.max(proposed, content)
    }

    static func anchor(_ alignment: Alignment) -> UnitPoint {
        let x: CGFloat = switch alignment.horizontal {
        case .leading: 0
        case .trailing: 1
        default: 0.5
        }
        let y: CGFloat = switch alignment.vertical {
        case .top: 0
        case .bottom: 1
        default: 0.5
        }
        return UnitPoint(x: x, y: y)
    }
}
