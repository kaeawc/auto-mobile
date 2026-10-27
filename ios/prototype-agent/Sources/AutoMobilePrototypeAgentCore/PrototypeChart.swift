import Foundation

/// One `chart` series (#14209): the `/data` array at `path`, its points' `y` and optional `x` members.
struct PrototypeChartSeries: Decodable, Equatable, Sendable {
    let path: String
    let x: String?
    let y: String
    let label: String
    let color: PrototypeModeValue?
}

/// One drawn point: its `x` label, if the series names an `x` member, and its `y` value.
struct PrototypeChartPoint: Equatable, Sendable {
    let x: String?
    let y: Double
}

struct PrototypeChartSeriesModel: Equatable, Sendable {
    let label: String
    let points: [PrototypeChartPoint]
    let color: PrototypeModeValue?
}

/// A `chart` node read against the current `/data`: its series' points, the y axis it is drawn
/// over, and the accessible `summary` that `observe` reports as its label. A twin of Android's
/// `PrototypeChart.model`, which the shared chart fixture keeps in step.
struct PrototypeChartModel: Equatable, Sendable {
    let variant: String
    let series: [PrototypeChartSeriesModel]
    let yMin: Double
    let yMax: Double
    let goal: Double?
    let xLabels: String
    let summary: String

    /// A ring's fraction: the latest value of its series against the goal, clamped to 0...1.
    var ringFraction: Double {
        let latest = series.first?.points.last?.y ?? 0
        let goal = goal ?? 1
        guard goal != 0 else { return latest > 0 ? 1 : 0 }
        return Swift.min(Swift.max(latest / goal, 0), 1)
    }

    /// The first series' x labels that are drawn: none, the two ends, or all of them.
    var shownXLabels: [String] {
        let labels = series.first?.points.compactMap(\.x) ?? []
        switch xLabels {
        case "all": return labels
        case "ends": return labels.count > 1 ? [labels[0], labels[labels.count - 1]] : labels
        default: return []
        }
    }
}

/// One drawn bar in plot units: x spans slot `index`'s group (slot `i` covers `i ... i + 1`), y
/// runs from the zero baseline to the clamped value. Numeric on both axes, so the renderer needs no
/// categorical scale: `BarMark.position(by:)` over an `Int` series drew nothing (#14679).
struct PrototypeChartBar: Equatable, Sendable {
    let seriesIndex: Int
    let index: Int
    let xStart: Double
    let xEnd: Double
    let yStart: Double
    let yEnd: Double
}

extension PrototypeChartModel {
    /// What VoiceOver and `observe` read for one drawn point: the x (category/day) label, or
    /// "Point N" when the series has none, prefixed by the series label when there are several,
    /// and the value as the summary formats it (#14679). Never the plot's internal coordinates.
    func pointDescription(seriesIndex: Int, index: Int) -> (label: String, value: String) {
        guard series.indices.contains(seriesIndex), series[seriesIndex].points.indices.contains(index)
        else { return ("", "") }
        let entry = series[seriesIndex]
        let point = entry.points[index]
        let name = point.x ?? "Point \(index + 1)"
        return (series.count > 1 ? "\(entry.label), \(name)" : name, PrototypeChart.format(point.y))
    }

    /// Slots along the x axis of a bar chart: the longest series' point count.
    var barSlots: Int { series.map(\.points.count).max() ?? 0 }

    /// Grouped bars: one slot per point index, `fill` of it shared evenly by the series.
    func bars(fill: Double) -> [PrototypeChartBar] {
        let count = Double(series.count)
        let width = fill / Swift.max(count, 1)
        let base = Swift.min(Swift.max(0, yMin), yMax)
        return series.enumerated().flatMap { seriesIndex, entry in
            entry.points.enumerated().map { index, point in
                let start = Double(index) + (1 - fill) / 2 + Double(seriesIndex) * width
                return PrototypeChartBar(
                    seriesIndex: seriesIndex, index: index, xStart: start, xEnd: start + width,
                    yStart: base, yEnd: Swift.min(Swift.max(point.y, yMin), yMax)
                )
            }
        }
    }
}

enum PrototypeChart {
    /// The chart's points read from `data`. A point that is not an object or whose `y` is not a
    /// finite number is skipped: validation rejects them in the shown spec, but a later `/data`
    /// write may not.
    static func model(
        variant: String, series definitions: [PrototypeChartSeries], yRange: PrototypeChartRange?,
        goal: Double?, xLabels: String?, data: [String: JSONValue]?
    )
        -> PrototypeChartModel
    {
        let series = definitions.map { definition -> PrototypeChartSeriesModel in
            guard case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: definition.path) else {
                return PrototypeChartSeriesModel(label: definition.label, points: [], color: definition.color)
            }
            let points = items.compactMap { item -> PrototypeChartPoint? in
                guard case let .object(point) = item, let y = number(point[definition.y]) else { return nil }
                return PrototypeChartPoint(x: definition.x.flatMap { label(point[$0]) }, y: y)
            }
            return PrototypeChartSeriesModel(label: definition.label, points: points, color: definition.color)
        }
        let range = yRange.map { ($0.min, $0.max) } ?? autoRange(variant: variant, series: series, goal: goal)
        return PrototypeChartModel(
            variant: variant, series: series, yMin: range.0, yMax: range.1, goal: goal,
            xLabels: xLabels ?? "none", summary: summary(variant: variant, series: series, goal: goal)
        )
    }

    /// The drawn y range: the values and goal, with bars rising from zero, never empty.
    private static func autoRange(
        variant: String, series: [PrototypeChartSeriesModel], goal: Double?
    )
        -> (Double, Double)
    {
        var values = series.flatMap { $0.points.map(\.y) } + [goal].compactMap(\.self)
        if variant == "bar" { values.append(0) }
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        return high > low ? (low, high) : (low - 1, high + 1)
    }

    /// "Line chart, Heart rate, 24 points, min 58, max 141, latest 72"; a ring reads its goal.
    static func summary(variant: String, series: [PrototypeChartSeriesModel], goal: Double?) -> String {
        let kind = "\(variant.prefix(1).uppercased() + variant.dropFirst()) chart"
        if variant == "ring" {
            let latest = series.first?.points.last?.y ?? 0
            return "\(kind), \(series.first?.label ?? ""), \(format(latest)) of \(goal.map(format) ?? "0")"
        }
        let parts = series.map { entry -> String in
            let ys = entry.points.map(\.y)
            guard let low = ys.min(), let high = ys.max(), let last = ys.last else {
                return "\(entry.label), no points"
            }
            return "\(entry.label), \(ys.count) \(ys.count == 1 ? "point" : "points"), " +
                "min \(format(low)), max \(format(high)), latest \(format(last))"
        }
        let goalPart = goal.map { ", goal \(format($0))" } ?? ""
        return "\(kind), \(parts.joined(separator: "; "))\(goalPart)"
    }

    /// At most two decimals, without trailing zeros: 72, 72.5, 0.33. Halves round away from zero
    /// as Android's `RoundingMode.HALF_UP` does (`%.2f` alone rounds an exact tie to even).
    static func format(_ value: Double) -> String {
        var rounded = value
        let eighths = abs(value) * 8
        // Only odd multiples of 0.125 are exact binary ties at two decimals.
        if eighths == eighths.rounded(), Int(exactly: eighths).map({ $0 % 2 == 1 }) == true {
            rounded = (abs(value) * 100).rounded(.toNearestOrAwayFromZero) / 100 * (value < 0 ? -1 : 1)
        }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text == "-0" ? "0" : text
    }

    private static func number(_ value: JSONValue?) -> Double? {
        if case let .number(number)? = value, number.isFinite { return number }
        return nil
    }

    private static func label(_ value: JSONValue?) -> String? {
        switch value {
        case let .string(text)?: text
        case let .number(number)?: number.isFinite ? format(number) : nil
        default: nil
        }
    }
}

extension PrototypeNode {
    /// This `chart` node read against `data`; nil for any other node.
    func chartModel(data: [String: JSONValue]?) -> PrototypeChartModel? {
        guard type == "chart", let variant, let chartSeries else { return nil }
        return PrototypeChart.model(
            variant: variant, series: chartSeries, yRange: yRange, goal: goal, xLabels: xLabels, data: data
        )
    }

    /// The accessible label: an authored `contentDescription` wins over the chart's summary.
    func chartLabel(data: [String: JSONValue]?, state: [String: JSONValue]) -> String? {
        if let authored = accessibilityLabel(state: state, pager: nil, tappable: false) { return authored }
        return chartModel(data: data)?.summary
    }
}
