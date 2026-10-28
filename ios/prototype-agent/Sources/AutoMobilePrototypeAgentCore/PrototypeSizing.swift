import Foundation

/// The main axis of a `row` (horizontal) or `column` (vertical).
enum PrototypeAxis: Equatable {
    case horizontal
    case vertical
}

/// A node's authored size, resolved the way Android's `authoredSizeModifier` does (#11543).
///
/// Android applies, outermost first: `sizeIn(min/max)` coerced into what the parent offers, then
/// `width`/`height` (`fill` takes the bound maximum, `{dp}` is coerced into min/max, wrap and unset
/// are `clamp(content, min, max)`), then `aspectRatio` on the resulting constraints. A `row`/`column`
/// child with a `weight` instead takes exactly the share its parent hands it on the main axis, which
/// overrides that axis's `width`/`height` and min/max (a fixed incoming constraint wins over them).
/// `min` beats `max` when an author gives `min > max` (Compose would throw; the host does not
/// reject it).
struct PrototypeSizeRules: Equatable {
    var width: Dimension?
    var height: Dimension?
    var minWidth: Double?
    var maxWidth: Double?
    var minHeight: Double?
    var maxHeight: Double?
    var aspectRatio: Double?
    /// The axis a `weight` fills, when the node is a weighted child of a row or column.
    var weightedAxis: PrototypeAxis?
    /// A `spacer` fills an axis it has no size on.
    var fillsByDefault = false
    /// Unweighted row children must accept the remaining width, including authored fixed sizes.
    var constrainsWidth = false

    init(
        style: Style?,
        coverSize: (width: Double, height: Double)? = nil,
        weightedAxis: PrototypeAxis? = nil,
        fillsByDefault: Bool = false,
        constrainsWidth: Bool = false
    ) {
        self.fillsByDefault = fillsByDefault
        self.constrainsWidth = constrainsWidth
        if let coverSize {
            // A cover anchor sizes the node to the anchor bounds: authored sizes would only wrap or
            // clamp it (as on Android).
            width = .points(coverSize.width)
            height = .points(coverSize.height)
            return
        }
        width = style?.width
        height = style?.height
        minWidth = style?.minWidth
        maxWidth = style?.maxWidth
        minHeight = style?.minHeight
        maxHeight = style?.maxHeight
        aspectRatio = style?.aspectRatio
        self.weightedAxis = style?.weight == nil ? nil : weightedAxis
    }

    /// Whether the plain `frame` path cannot express this size.
    var needsResolvedLayout: Bool {
        constrainsWidth || weightedAxis != nil || aspectRatio != nil
            || minWidth != nil || maxWidth != nil || minHeight != nil || maxHeight != nil
    }

    /// An unsized or filling spacer in an unweighted row shares the free space after content,
    /// like the flexible slots inserted for `space*` arrangements. Fixed/wrap spacers stay content.
    var unweightedRowWeight: Double? {
        guard fillsByDefault else { return nil }
        switch width {
        case nil, .fill?: return 1
        default: return nil
        }
    }
}

enum PrototypeSizing {
    typealias Size = (width: Double, height: Double)

    /// Where content sits inside the box the rules sized, as a unit anchor. An axis with no
    /// authored size (unset or `wrap`) is Android's `wrapContentWidth()`/`wrapContentHeight()`, which
    /// centre the content in whatever a min bound grew the box to; every other axis (`fill`, `{dp}`,
    /// a weight's share, an aspect ratio) keeps the node's own `alignment`.
    static func contentAnchor(
        _ rules: PrototypeSizeRules,
        alignment: (x: Double, y: Double)
    )
        -> (x: Double, y: Double)
    {
        let wrapsWidth = wraps(rules.width, weighted: rules.weightedAxis == .horizontal, rules: rules)
        let wrapsHeight = wraps(rules.height, weighted: rules.weightedAxis == .vertical, rules: rules)
        return (wrapsWidth ? 0.5 : alignment.x, wrapsHeight ? 0.5 : alignment.y)
    }

    private static func wraps(_ dimension: Dimension?, weighted: Bool, rules: PrototypeSizeRules) -> Bool {
        guard !weighted, rules.aspectRatio == nil else { return false }
        switch dimension {
        case .wrap?: return true
        case nil: return !rules.fillsByDefault
        default: return false
        }
    }

    /// The size the node takes. `proposed` is the room the parent offers per axis (nil: unbounded),
    /// `content` measures the node's content given the largest size it may take per axis.
    static func resolve(
        _ rules: PrototypeSizeRules,
        proposed: (width: Double?, height: Double?),
        content: (_ maxWidth: Double?, _ maxHeight: Double?) -> Size
    )
        -> Size
    {
        let widthAxis = Axis(
            dimension: rules.width,
            min: rules.minWidth,
            max: rules.maxWidth,
            proposed: proposed.width,
            weighted: rules.weightedAxis == .horizontal,
            fillsByDefault: rules.fillsByDefault
        )
        let heightAxis = Axis(
            dimension: rules.height,
            min: rules.minHeight,
            max: rules.maxHeight,
            proposed: proposed.height,
            weighted: rules.weightedAxis == .vertical,
            fillsByDefault: rules.fillsByDefault
        )
        if let ratio = rules.aspectRatio, ratio > 0,
           let fitted = aspectSize(ratio: ratio, width: widthAxis.constraint, height: heightAxis.constraint)
        {
            return fitted
        }
        let measured = content(widthAxis.fixed ?? widthAxis.high, heightAxis.fixed ?? heightAxis.high)
        return (
            widthAxis.fixed ?? widthAxis.clamp(measured.width),
            heightAxis.fixed ?? heightAxis.clamp(measured.height)
        )
    }

    /// One axis after the bounds: the range left by min/max inside the proposal, and the exact size
    /// `width`/`height`/`weight` pin it to, if any.
    private struct Axis {
        let low: Double
        let high: Double?
        let fixed: Double?

        init(
            dimension: Dimension?,
            min: Double?,
            max: Double?,
            proposed: Double?,
            weighted: Bool,
            fillsByDefault: Bool
        ) {
            if weighted, let proposed {
                low = proposed
                high = proposed
                fixed = proposed
                return
            }
            let ceiling = proposed ?? .infinity
            let lowest = Swift.min(Swift.max(min ?? 0, 0), ceiling)
            let highest = Swift.max(Swift.min(max ?? .infinity, ceiling), lowest)
            low = lowest
            high = highest.isFinite ? highest : nil
            switch dimension {
            case .fill?:
                fixed = high
            case let .points(value)?:
                fixed = Swift.min(Swift.max(value, lowest), highest)
            case .wrap?:
                fixed = nil
            case nil:
                fixed = fillsByDefault ? high : nil
            }
        }

        /// What the axis hands `aspectRatio`: exact when pinned, else anything up to the bound.
        var constraint: (low: Double, high: Double?) {
            fixed.map { ($0, $0) } ?? (0, high)
        }

        func clamp(_ value: Double) -> Double {
            Swift.min(Swift.max(value, low), high ?? .infinity)
        }
    }

    /// Compose's `aspectRatio(ratio)` (`matchHeightConstraintsFirst = false`): the first of the
    /// largest width, the largest height, the smallest width, the smallest height that keeps the
    /// ratio inside the constraints; a candidate outside them is only taken (coerced) when none fits.
    /// Nil when the constraints are unbounded and have no minimum, so the content decides.
    static func aspectSize(
        ratio: Double,
        width: (low: Double, high: Double?),
        height: (low: Double, high: Double?)
    )
        -> Size?
    {
        var candidates: [Size] = []
        if let high = width.high { candidates.append((high, high / ratio)) }
        if let high = height.high { candidates.append((high * ratio, high)) }
        if width.low != 0 { candidates.append((width.low, width.low / ratio)) }
        if height.low != 0 { candidates.append((height.low * ratio, height.low)) }
        let usable = candidates.filter { $0.width > 0 && $0.height > 0 }
        func within(_ value: Double, _ range: (low: Double, high: Double?)) -> Bool {
            value >= range.low - 1e-9 && value <= (range.high ?? .infinity) + 1e-9
        }
        if let fit = usable.first(where: { within($0.width, width) && within($0.height, height) }) {
            return fit
        }
        return usable.first.map { candidate in
            (
                Swift.min(Swift.max(candidate.width, width.low), width.high ?? .infinity),
                Swift.min(Swift.max(candidate.height, height.low), height.high ?? .infinity)
            )
        }
    }
}

/// How a `row`/`column` splits its main axis, as Compose's `Row`/`Column` do: unweighted children
/// are measured first in order, each offered what the gaps and earlier siblings left; the space
/// still free is then shared out by weight, exactly (never less than zero).
enum PrototypeWeightedStack {
    /// The main-axis size of each child. `available` is nil on an unbounded axis, where a weight
    /// has no space to share and resolves to zero. `measureFixed` returns an unweighted child's size
    /// given the most it may take. With `measuresFlexibleSlots`, weights identify an unweighted row's
    /// spacer slots instead: measure their shares too, respecting caps and redistributing unused
    /// space. On an unbounded axis these spacers keep their ideal sizes.
    static func mainSizes(
        available: Double?,
        spacing: Double,
        weights: [Double?],
        measuresFlexibleSlots: Bool = false,
        measureFixed: (_ index: Int, _ most: Double?) -> Double
    )
        -> [Double]
    {
        if measuresFlexibleSlots, available == nil {
            return weights.indices.map { measureFixed($0, nil) }
        }
        var sizes = [Double](repeating: 0, count: weights.count)
        var used = spacing * Double(Swift.max(weights.count - 1, 0))
        var totalWeight = 0.0
        for (index, weight) in weights.enumerated() {
            if let weight, weight > 0 {
                totalWeight += weight
            } else {
                sizes[index] = measureFixed(index, available.map { Swift.max($0 - used, 0) })
                used += sizes[index]
            }
        }
        guard totalWeight > 0 else { return sizes }
        let unit = Swift.max((available ?? 0) - used, 0) / totalWeight
        for (index, weight) in weights.enumerated() {
            if let weight, weight > 0 { sizes[index] = weight * unit }
        }
        guard measuresFlexibleSlots else { return sizes }
        var pending = weights.indices.filter { (weights[$0] ?? 0) > 0 }
        while !pending.isEmpty {
            let count = pending.count
            pending = pending.filter { index in
                let measured = Swift.min(Swift.max(measureFixed(index, sizes[index]), 0), sizes[index])
                guard measured < sizes[index] else { return true }
                sizes[index] = measured
                used += measured
                return false
            }
            // Every pass settles at least one capped slot, or all remaining slots fill their shares.
            guard pending.count < count, !pending.isEmpty else { break }
            let remainingWeight = pending.reduce(0) { $0 + (weights[$1] ?? 0) }
            let unit = Swift.max((available ?? 0) - used, 0) / remainingWeight
            for index in pending {
                sizes[index] = (weights[index] ?? 0) * unit
            }
        }
        return sizes
    }
}
