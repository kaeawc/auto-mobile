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
    /// `content` measures the node's content given the largest size it may take per axis. A zero
    /// proposal probes the authored minimum; a weighted axis still takes exactly its assigned share.
    static func resolve(
        _ rules: PrototypeSizeRules,
        proposed: (width: Double?, height: Double?),
        content: (_ maxWidth: Double?, _ maxHeight: Double?) -> Size
    )
        -> Size
    {
        var offered = (
            width: proposed.width.flatMap { $0.isFinite ? $0 : nil },
            height: proposed.height.flatMap { $0.isFinite ? $0 : nil }
        )
        if offered.width == 0, rules.weightedAxis != .horizontal {
            offered.width = Axis.minimum(dimension: rules.width, min: rules.minWidth, max: rules.maxWidth)
            if let ratio = rules.aspectRatio, ratio > 0, case .points? = rules.height {
                let height = Axis.minimum(dimension: rules.height, min: rules.minHeight, max: rules.maxHeight)
                offered.width = Swift.max(offered.width ?? 0, height * ratio)
            }
        }
        if offered.height == 0, rules.weightedAxis != .vertical {
            offered.height = Axis.minimum(dimension: rules.height, min: rules.minHeight, max: rules.maxHeight)
            if let ratio = rules.aspectRatio, ratio > 0, case .points? = rules.width {
                let width = Axis.minimum(dimension: rules.width, min: rules.minWidth, max: rules.maxWidth)
                offered.height = Swift.max(offered.height ?? 0, width / ratio)
            }
        }
        let widthAxis = Axis(
            dimension: rules.width,
            min: rules.minWidth,
            max: rules.maxWidth,
            proposed: offered.width,
            weighted: rules.weightedAxis == .horizontal,
            fillsByDefault: rules.fillsByDefault
        )
        let heightAxis = Axis(
            dimension: rules.height,
            min: rules.minHeight,
            max: rules.maxHeight,
            proposed: offered.height,
            weighted: rules.weightedAxis == .vertical,
            fillsByDefault: rules.fillsByDefault
        )
        var resolved: Size
        if let ratio = rules.aspectRatio, ratio > 0,
           let fitted = aspectSize(ratio: ratio, width: widthAxis.constraint, height: heightAxis.constraint)
        {
            resolved = fitted
        } else {
            let measured = content(widthAxis.fixed ?? widthAxis.high, heightAxis.fixed ?? heightAxis.high)
            resolved = (
                widthAxis.fixed ?? widthAxis.clamp(measured.width),
                heightAxis.fixed ?? heightAxis.clamp(measured.height)
            )
        }
        if proposed.width == .infinity || proposed.height == .infinity {
            let probe = content(
                proposed.width == .infinity ? .infinity : widthAxis.fixed ?? widthAxis.high,
                proposed.height == .infinity ? .infinity : heightAxis.fixed ?? heightAxis.high
            )
            if proposed.width == .infinity, widthAxis.fixed == nil, probe.width == .infinity {
                resolved.width = widthAxis.clamp(.infinity)
            }
            if proposed.height == .infinity, heightAxis.fixed == nil, probe.height == .infinity {
                resolved.height = heightAxis.clamp(.infinity)
            }
        }
        return resolved
    }

    /// One axis after the bounds: the range left by min/max inside the proposal, and the exact size
    /// `width`/`height`/`weight` pin it to, if any.
    private struct Axis {
        let low: Double
        let high: Double?
        let fixed: Double?

        static func minimum(dimension: Dimension?, min: Double?, max: Double?) -> Double {
            let authored = Axis(
                dimension: dimension, min: min, max: max, proposed: nil,
                weighted: false, fillsByDefault: false
            )
            if case .points? = dimension { return authored.fixed ?? authored.low }
            return authored.low
        }

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

/// Splits the main axis, reserving minima and measuring least-flexible row content first when
/// minima are supplied. Columns and unbounded rows measure in order; weights take the remainder.
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
        minimums: [Double]? = nil,
        priorities: [Double]? = nil,
        leastFlexibleFirst: Bool = false,
        measuresFlexibleSlots: Bool = false,
        measureFixed: (_ index: Int, _ most: Double?) -> Double
    )
        -> [Double]
    {
        if measuresFlexibleSlots, available == nil {
            return weights.indices.map { measureFixed($0, nil) }
        }
        if leastFlexibleFirst, let available, let minimums {
            let fills = weights.map { ($0 ?? 0) > 0 }
            if measuresFlexibleSlots {
                // Row slots are measured content, not exact authored weights: caps and minima
                // participate in the same redistribution as greedy controls.
                return PrototypeRowSizing.widths(
                    available: available, spacing: spacing, minimums: minimums, fills: fills,
                    priorities: priorities ?? weights.map { _ in 0 }, measure: measureFixed
                )
            }
            let greedy = weights.indices.map {
                !fills[$0] && measureFixed($0, .infinity) > measureFixed($0, nil)
            }
            var sizes = PrototypeRowSizing.widths(
                available: available, spacing: spacing, minimums: minimums, fills: fills,
                priorities: priorities ?? weights.map { _ in 0 }
            ) { index, most in
                if fills[index] { return most ?? 0 }
                let offered = greedy[index] && (most == nil || most == .infinity) ? available : most
                return measureFixed(index, offered)
            }
            let remaining = weights.indices.filter { fills[$0] }.reduce(0.0) { $0 + sizes[$1] }
            let totalWeight = weights.compactMap { $0 }.filter { $0 > 0 }.reduce(0, +)
            for index in weights.indices where fills[index] {
                sizes[index] = remaining * (weights[index] ?? 0) / totalWeight
            }
            return sizes
        }
        var sizes = [Double](repeating: 0, count: weights.count)
        var used = spacing * Double(Swift.max(weights.count - 1, 0))
        var totalWeight = 0.0
        var reserved = weights.indices.reduce(0.0) {
            $0 + ((weights[$1] ?? 0) > 0 ? 0 : (minimums?[$1] ?? 0))
        }
        for (index, weight) in weights.enumerated() {
            if let weight, weight > 0 {
                totalWeight += weight
            } else {
                reserved -= minimums?[index] ?? 0
                let minimum = minimums?[index] ?? 0
                let most = available.map { Swift.max($0 - used - reserved, minimum) }
                let measured = measureFixed(index, most)
                if minimums != nil || measuresFlexibleSlots, let most {
                    sizes[index] = Swift.min(Swift.max(measured, minimum), most)
                } else {
                    sizes[index] = measured
                }
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

/// Allocates rigid content before flexible content, then shares unused width among fills and greedy controls.
/// Measurement order never changes placement order; minimums may overflow a bounded proposal.
enum PrototypeRowSizing {
    static func widths(
        available: Double?,
        spacing: Double,
        minimums: [Double],
        fills: [Bool],
        priorities: [Double],
        measure: (_ index: Int, _ most: Double?) -> Double
    )
        -> [Double]
    {
        let ideals = minimums.indices.map { measure($0, nil) }
        guard let available else { return ideals }
        let sharesRemainder = minimums.indices.map { fills[$0] || measure($0, .infinity) > ideals[$0] }
        let order = minimums.indices.filter { !sharesRemainder[$0] }.sorted {
            if priorities[$0] != priorities[$1] { return priorities[$0] > priorities[$1] }
            let firstFlexibility = max(ideals[$0] - minimums[$0], 0)
            let secondFlexibility = max(ideals[$1] - minimums[$1], 0)
            return firstFlexibility == secondFlexibility ? $0 < $1 : firstFlexibility < secondFlexibility
        }
        var result = [Double](repeating: 0, count: minimums.count)
        var reserved = minimums.reduce(0, +)
        var used = spacing * Double(max(minimums.count - 1, 0))
        for index in order {
            reserved -= minimums[index]
            let most = max(min(ideals[index], available - used - reserved), minimums[index])
            result[index] = max(min(measure(index, most), most), minimums[index])
            used += result[index]
        }
        var pending = minimums.indices.filter { sharesRemainder[$0] }
        var remaining = max(available - used, pending.reduce(0.0) { $0 + minimums[$1] })
        while !pending.isEmpty {
            let share = remaining / Double(pending.count)
            let minimumExceedsShare = pending.contains { minimums[$0] > share }
            var settled: [Int] = []
            for index in pending {
                let offered = max(share, minimums[index])
                result[index] = max(min(measure(index, offered), offered), minimums[index])
                if minimums[index] > share || (!minimumExceedsShare && result[index] < share) {
                    settled.append(index)
                }
            }
            if settled.isEmpty { break }
            for index in settled {
                remaining -= result[index]
            }
            pending.removeAll { settled.contains($0) }
        }
        return result
    }
}
