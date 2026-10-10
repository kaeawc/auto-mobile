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

    init(
        style: Style?,
        coverSize: (width: Double, height: Double)? = nil,
        weightedAxis: PrototypeAxis? = nil,
        fillsByDefault: Bool = false
    ) {
        self.fillsByDefault = fillsByDefault
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
        weightedAxis != nil || aspectRatio != nil
            || minWidth != nil || maxWidth != nil || minHeight != nil || maxHeight != nil
    }
}

enum PrototypeSizing {
    typealias Size = (width: Double, height: Double)

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
    /// given the most it may take.
    static func mainSizes(
        available: Double?,
        spacing: Double,
        weights: [Double?],
        measureFixed: (_ index: Int, _ most: Double?) -> Double
    )
        -> [Double]
    {
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
        return sizes
    }
}
