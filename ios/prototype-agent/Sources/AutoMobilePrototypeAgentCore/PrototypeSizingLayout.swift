import SwiftUI

/// Marks authored fills, spacer nodes, unsized horizontal dividers and arrangement spacers sharing row width.
struct PrototypeRowFillKey: LayoutValueKey {
    static let defaultValue = false
}

/// Measures row content least-flexible first and places it in authored order, retaining minima.
/// Cached measurements preserve ideal fill widths through bounded scroll-content wrappers.
struct PrototypeRowLayout: Layout {
    let spacing: Double

    struct Frames {
        let widths: [Double]
        let height: Double
        let width: Double
    }

    struct Measurement {
        let proposal: ProposedViewSize
        let frames: Frames
    }

    struct Cache {
        var measurements: [Measurement] = []
    }

    func makeCache(subviews _: Subviews) -> Cache { Cache() }

    func updateCache(_ cache: inout Cache, subviews _: Subviews) { cache = Cache() }

    private func frames(for proposal: ProposedViewSize, subviews: Subviews) -> Frames {
        let available = proposal.width.flatMap { $0.isFinite ? Double($0) : nil }
        let fills = subviews.map { $0[PrototypeRowFillKey.self] }
        let minimums = subviews.indices.map { index in
            available == nil ? 0 : Double(subviews[index].sizeThatFits(
                ProposedViewSize(width: 0, height: proposal.height)
            ).width)
        }
        let widths = PrototypeRowSizing.widths(
            available: available,
            spacing: spacing,
            minimums: minimums,
            fills: fills,
            priorities: subviews.map(\.priority)
        ) { index, most in
            Double(subviews[index].sizeThatFits(
                ProposedViewSize(width: most.map { CGFloat($0) }, height: proposal.height)
            ).width)
        }
        let heights = subviews.indices.map { index in
            Double(subviews[index].sizeThatFits(
                ProposedViewSize(width: widths[index], height: proposal.height)
            ).height)
        }
        return Frames(
            widths: widths,
            height: heights.max() ?? 0,
            width: widths.reduce(0, +) + spacing * Double(Swift.max(subviews.count - 1, 0))
        )
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let result: Frames
        if let measured = cache.measurements.last(where: { $0.proposal == proposal }) {
            result = measured.frames
        } else {
            result = frames(for: proposal, subviews: subviews)
            cache.measurements.append(Measurement(proposal: proposal, frames: result))
            if cache.measurements.count > 4 { cache.measurements.removeFirst() }
        }
        let greedy = proposal.width == .infinity && subviews.contains {
            $0[PrototypeRowFillKey.self]
                || $0.sizeThatFits(ProposedViewSize(width: .infinity, height: proposal.height)).width
                > $0.sizeThatFits(ProposedViewSize(width: nil, height: proposal.height)).width
        }
        return CGSize(width: greedy ? .infinity : result.width, height: result.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let unbounded = proposal.width == nil || proposal.width?.isFinite == false
        let result: Frames
        if let measured = cache.measurements.last(where: {
            $0.proposal.height == proposal.height
                && ($0.frames.width == bounds.width || (unbounded && $0.proposal == proposal))
        }) {
            result = measured.frames
        } else {
            result = frames(
                for: ProposedViewSize(width: unbounded ? nil : bounds.width, height: proposal.height),
                subviews: subviews
            )
        }
        var leading = bounds.minX
        for index in subviews.indices {
            subviews[index].place(
                at: CGPoint(x: leading, y: bounds.midY),
                anchor: .leading,
                proposal: ProposedViewSize(width: result.widths[index], height: proposal.height)
            )
            leading += result.widths[index] + spacing
        }
    }
}

extension CGFloat {
    /// SwiftUI proposes `.infinity` for "as large as you like"; bounded stack allocation uses nil.
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
        let size = PrototypeSizing.resolve(
            rules, proposed: (offered.width.map { Double($0) }, offered.height.map { Double($0) })
        ) { maxWidth, maxHeight in
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

/// A `row` or `column` with at least one weighted child, laid out by `PrototypeWeightedStack`.
/// Children are centred across a row and leading-aligned down a column, as in the plain stacks.
/// SwiftUI mirrors a custom `Layout`'s placements under right-to-left on its own (proved by
/// `PrototypeSizingLayoutTests`), so a row reverses and a column's leading edge flips with no
/// layout-direction handling here.
/// A weighted stack has no free space left for `space*` arrangements, so it adds no spacers.
struct PrototypeWeightedStackLayout: Layout {
    let axis: PrototypeAxis
    let spacing: Double

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
        let minimums = limits.main != nil ? subviews.indices.map { index in
            (weights[index] ?? 0) > 0 ? 0 : Double(subviews[index].sizeThatFits(
                offer(main: 0, cross: limits.cross)
            )[keyPath: isHorizontal() ? \CGSize.width : \CGSize.height])
        } : nil
        let main = PrototypeWeightedStack.mainSizes(
            available: limits.main,
            spacing: spacing,
            weights: weights,
            minimums: minimums,
            priorities: isHorizontal() ? subviews.map(\.priority) : nil,
            leastFlexibleFirst: isHorizontal()
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
        // A weight fills what is left, so a bounded stack with one takes the whole axis.
        let total = weights.contains { ($0 ?? 0) > 0 } ? max(sum, limits.main ?? sum) : sum
        return Frames(main: main, cross: cross, mainTotal: total)
    }

    func sizeThatFits(proposal offered: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let result = frames(for: offered, subviews: subviews)
        let cross = result.cross.max() ?? 0
        let mainProposal = isHorizontal() ? offered.width : offered.height
        let greedy = mainProposal == .infinity && subviews.contains {
            if ($0[PrototypeWeightKey.self] ?? 0) > 0 { return true }
            let size = $0.sizeThatFits(offer(main: .infinity, cross: split(offered).cross))
            let ideal = $0.sizeThatFits(offer(main: nil, cross: split(offered).cross))
            return (isHorizontal() ? size.width : size.height) > (isHorizontal() ? ideal.width : ideal.height)
        }
        let main = greedy ? Double.infinity : result.mainTotal
        return isHorizontal()
            ? CGSize(width: main, height: cross)
            : CGSize(width: cross, height: main)
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
