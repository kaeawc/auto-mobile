import SwiftUI

extension CGFloat {
    /// SwiftUI proposes `.infinity` for "as large as you like"; the sizing model uses nil.
    fileprivate var finiteOrNil: Double? { isFinite ? Double(self) : nil }
}

extension ProposedViewSize {
    fileprivate var bounds: (width: Double?, height: Double?) { (width?.finiteOrNil, height?.finiteOrNil) }
}

private func proposal(width: Double?, height: Double?) -> ProposedViewSize {
    ProposedViewSize(width: width.map { CGFloat($0) }, height: height.map { CGFloat($0) })
}

/// Sizes one child by `PrototypeSizing.resolve` (min/max, aspect ratio, a weight's share) and
/// places it at exactly that size, so the bounds hold whatever the child would have measured.
struct PrototypeSizedLayout: Layout {
    let rules: PrototypeSizeRules
    let alignment: Alignment

    func sizeThatFits(proposal offered: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let size = PrototypeSizing.resolve(rules, proposed: offered.bounds) { maxWidth, maxHeight in
            let measured = subviews.first?.sizeThatFits(proposal(width: maxWidth, height: maxHeight)) ?? .zero
            return (Double(measured.width), Double(measured.height))
        }
        return CGSize(width: size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        let aligned = PrototypeLayeredLayout.anchor(alignment)
        let centred = PrototypeSizing.contentAnchor(rules, alignment: (Double(aligned.x), Double(aligned.y)))
        let anchor = UnitPoint(x: centred.x, y: centred.y)
        for child in subviews {
            child.place(
                at: CGPoint(x: bounds.minX + bounds.width * anchor.x, y: bounds.minY + bounds.height * anchor.y),
                anchor: anchor,
                proposal: ProposedViewSize(bounds.size)
            )
        }
    }
}

/// A child's `weight`, read by `PrototypeWeightedStackLayout`.
struct PrototypeWeightKey: LayoutValueKey {
    static let defaultValue: Double? = nil
}

/// An unweighted row uses the same remaining-width measurement as a weighted stack. Its native
/// arrangement spacers must expand horizontally only, as they did under `HStack`.
struct PrototypeRowLayout: Layout {
    let spacing: Double

    static var layoutProperties: LayoutProperties {
        var properties = LayoutProperties()
        properties.stackOrientation = .horizontal
        return properties
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        PrototypeWeightedStackLayout(axis: .horizontal, spacing: spacing, measuresFlexibleSlots: true)
            .sizeThatFits(proposal: proposal, subviews: subviews, cache: &cache)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        PrototypeWeightedStackLayout(axis: .horizontal, spacing: spacing, measuresFlexibleSlots: true)
            .placeSubviews(in: bounds, proposal: proposal, subviews: subviews, cache: &cache)
    }
}

/// A `row` or `column`, laid out by `PrototypeWeightedStack`.
/// Children are centred across a row and leading-aligned down a column, as in the plain stacks.
/// SwiftUI mirrors a custom `Layout`'s placements under right-to-left on its own (proved by
/// `PrototypeSizingLayoutTests`), so a row reverses and a column's leading edge flips with no
/// layout-direction handling here.
/// A weighted stack has no free space left for `space*` arrangements, so it adds no spacers.
struct PrototypeWeightedStackLayout: Layout {
    let axis: PrototypeAxis
    let spacing: Double
    var measuresFlexibleSlots = false

    private struct Frames {
        var main: [Double]
        var cross: [Double]
        var mainTotal: Double
    }

    private func isHorizontal() -> Bool { axis == .horizontal }

    private func split(_ proposal: ProposedViewSize) -> (main: Double?, cross: Double?) {
        let bounds = proposal.bounds
        return isHorizontal() ? (bounds.width, bounds.height) : (bounds.height, bounds.width)
    }

    private func offer(main: Double?, cross: Double?) -> ProposedViewSize {
        isHorizontal() ? proposal(width: main, height: cross) : proposal(width: cross, height: main)
    }

    private func frames(for offered: ProposedViewSize, subviews: Subviews) -> Frames {
        let limits = split(offered)
        let weights = subviews.map { $0[PrototypeWeightKey.self] }
        let main = PrototypeWeightedStack.mainSizes(
            available: limits.main,
            spacing: spacing,
            weights: weights,
            measuresFlexibleSlots: measuresFlexibleSlots
        ) { index, most in
            let size = subviews[index].sizeThatFits(offer(main: most, cross: limits.cross))
            return Double(isHorizontal() ? size.width : size.height)
        }
        let cross = subviews.indices.map { index -> Double in
            let size = subviews[index].sizeThatFits(offer(main: main[index], cross: limits.cross))
            return Double(isHorizontal() ? size.height : size.width)
        }
        let gaps = spacing * Double(max(subviews.count - 1, 0))
        let sum = main.reduce(0, +) + gaps
        // Authored weights fill the axis. Flexible spacer slots can cap below their shares,
        // leaving a wrap-sized row smaller than the proposal.
        let fills = !measuresFlexibleSlots && weights.contains { ($0 ?? 0) > 0 }
        let total = fills ? max(sum, limits.main ?? sum) : sum
        return Frames(main: main, cross: cross, mainTotal: total)
    }

    func sizeThatFits(proposal offered: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let result = frames(for: offered, subviews: subviews)
        let cross = result.cross.max() ?? 0
        return isHorizontal()
            ? CGSize(width: result.mainTotal, height: cross)
            : CGSize(width: cross, height: result.mainTotal)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        let result = frames(for: ProposedViewSize(bounds.size), subviews: subviews)
        var cursor = isHorizontal() ? bounds.minX : bounds.minY
        for (index, child) in subviews.enumerated() {
            let main = result.main[index]
            let cross = result.cross[index]
            let size = isHorizontal() ? CGSize(width: main, height: cross) : CGSize(width: cross, height: main)
            let origin = isHorizontal()
                ? CGPoint(x: cursor, y: bounds.midY - cross / 2)
                : CGPoint(x: bounds.minX, y: cursor)
            child.place(at: origin, anchor: .topLeading, proposal: ProposedViewSize(size))
            cursor += main + spacing
        }
    }
}
