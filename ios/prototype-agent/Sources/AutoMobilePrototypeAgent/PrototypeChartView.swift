#if canImport(UIKit)
    import Charts
    import SwiftUI
    import UIKit

    // The `chart` node (#14209, #14679): line, area and bar charts and a ring, drawn with Swift
    // Charts from the points `PrototypeChart` reads out of `/data`. The marks follow Android's
    // Compose `Canvas` renderer: no axes or gridlines, a dashed goal rule, grouped bars rising from
    // zero, x labels as a separate visual-only row, a ring of the latest value against the goal.

    private let chartHeight: CGFloat = 160
    private let ringSize: CGFloat = 120
    private let areaOpacity = 0.25
    private let barFill = 0.7

    @MainActor
    struct PrototypeChartView: View {
        @Environment(\.prototypePalette) private var palette
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            if let chart = node.chartModel(data: model.spec?.data) {
                if chart.variant == "ring" {
                    ring(chart)
                } else {
                    VStack(spacing: 0) {
                        plot(chart)
                            .accessibilityChartDescriptor(PrototypeChartDescriptor(
                                chart: chart,
                                title: node.chartLabel(data: model.spec?.data, state: model.state) ?? chart.summary
                            ))
                        xLabels(chart)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }

        private func role(_ name: String, _ fallback: Color) -> Color {
            palette.themed ? palette.color(role: name).map { Color($0) } ?? fallback : fallback
        }

        /// An authored series colour, else the theme's primary, tertiary, secondary and error in turn.
        private func color(_ chart: PrototypeChartModel, _ index: Int) -> Color {
            if let authored = palette.color(chart.series[index].color) { return authored }
            return [
                role("primary", .accentColor), role("tertiary", .purple),
                role("secondary", .gray), role("error", .red),
            ][index % 4]
        }

        private func clamp(_ value: Double, _ chart: PrototypeChartModel) -> Double {
            Swift.min(Swift.max(value, chart.yMin), chart.yMax)
        }

        private var goalStyle: StrokeStyle { StrokeStyle(lineWidth: 1, dash: [6, 6]) }

        @ViewBuilder
        private func plot(_ chart: PrototypeChartModel) -> some View {
            if chart.variant == "bar" {
                bars(chart)
            } else {
                lines(chart)
            }
        }

        private func lines(_ chart: PrototypeChartModel) -> some View {
            let slots = chart.series.map(\.points.count).max() ?? 0
            // The first point sits on the left edge and the last on the right; a lone point centres.
            let domain: ClosedRange<Double> = slots > 1 ? 0 ... Double(slots - 1) : -1 ... 1
            return Chart {
                ForEach(Array(chart.series.enumerated()), id: \.offset) { seriesIndex, series in
                    ForEach(Array(series.points.enumerated()), id: \.offset) { index, point in
                        lineMarks(chart, seriesIndex: seriesIndex, label: series.label, index: index, y: point.y)
                    }
                }
                goalRule(chart)
            }
            .chartXScale(domain: domain, range: .plotDimension(padding: 0))
            .chartYScale(domain: chart.yMin ... chart.yMax, range: .plotDimension(padding: 0))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: chartHeight)
        }

        @ChartContentBuilder
        private func lineMarks(
            _ chart: PrototypeChartModel, seriesIndex: Int, label: String, index: Int, y: Double
        )
            -> some ChartContent
        {
            let drawn: Double = clamp(y, chart)
            let tint: Color = color(chart, seriesIndex)
            if chart.variant == "area" {
                AreaMark(
                    x: .value("Index", index),
                    yStart: .value("Base", chart.yMin),
                    yEnd: .value(label, drawn),
                    series: .value("Series", seriesIndex)
                )
                .foregroundStyle(tint.opacity(areaOpacity))
                .accessibilityHidden(true)
            }
            LineMark(
                x: .value("Index", index),
                y: .value(label, drawn),
                series: .value("Series", seriesIndex)
            )
            .foregroundStyle(tint)
            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .accessibilityLabel(chart.pointDescription(seriesIndex: seriesIndex, index: index).label)
            .accessibilityValue(chart.pointDescription(seriesIndex: seriesIndex, index: index).value)
        }

        /// Grouped bars: one slot per point index, one bar per series within it, rising from zero.
        /// Each bar is a numeric rectangle from `PrototypeChartModel.bars`: `BarMark.position(by:)`
        /// over an `Int` series drew no bars at all on iOS 27 (#14679).
        private func bars(_ chart: PrototypeChartModel) -> some View {
            let drawn = chart.bars(fill: barFill)
            return Chart {
                ForEach(Array(drawn.enumerated()), id: \.offset) { _, bar in
                    barMark(chart, bar)
                }
                goalRule(chart)
            }
            .chartXScale(domain: 0 ... Double(Swift.max(chart.barSlots, 1)), range: .plotDimension(padding: 0))
            .chartYScale(domain: chart.yMin ... chart.yMax, range: .plotDimension(padding: 0))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: chartHeight)
        }

        @ChartContentBuilder
        private func barMark(_ chart: PrototypeChartModel, _ bar: PrototypeChartBar) -> some ChartContent {
            RectangleMark(
                xStart: .value("Start", bar.xStart),
                xEnd: .value("End", bar.xEnd),
                yStart: .value("Base", bar.yStart),
                yEnd: .value(chart.series[bar.seriesIndex].label, bar.yEnd)
            )
            .foregroundStyle(color(chart, bar.seriesIndex))
            .cornerRadius(2)
            .accessibilityLabel(chart.pointDescription(seriesIndex: bar.seriesIndex, index: bar.index).label)
            .accessibilityValue(chart.pointDescription(seriesIndex: bar.seriesIndex, index: bar.index).value)
        }

        @ChartContentBuilder
        private func goalRule(_ chart: PrototypeChartModel) -> some ChartContent {
            if let goal = chart.goal {
                RuleMark(y: .value("Goal", clamp(goal, chart)))
                    .lineStyle(goalStyle)
                    .foregroundStyle(role("outline", Color(UIColor.separator)))
            }
        }

        private func ring(_ chart: PrototypeChartModel) -> some View {
            let fraction = chart.ringFraction
            return Chart {
                SectorMark(angle: .value("Done", fraction), innerRadius: .ratio(0.8))
                    .foregroundStyle(color(chart, 0))
                SectorMark(angle: .value("Remaining", 1 - fraction), innerRadius: .ratio(0.8))
                    .foregroundStyle(role("surfaceVariant", Color(UIColor.systemFill)))
            }
            .chartLegend(.hidden)
            .frame(width: ringSize, height: ringSize)
            // A ring has no axes to describe; the node's label (set by the renderer) is its summary.
            .accessibilityElement(children: .ignore)
        }

        /// The first series' x labels: none, the two ends, or all of them evenly spaced.
        @ViewBuilder
        private func xLabels(_ chart: PrototypeChartModel) -> some View {
            let shown = chart.shownXLabels
            if !shown.isEmpty {
                HStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { index, label in
                        if index > 0 { Spacer(minLength: 0) }
                        Text(label)
                            .font(.caption2)
                            .foregroundColor(role("onSurfaceVariant", .secondary))
                            .lineLimit(1)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
    }

    /// VoiceOver's audio graph for a line, area or bar chart: one data series per chart series, with
    /// the point index on x. Its summary is the same text `observe` reports as the node's label.
    struct PrototypeChartDescriptor: AXChartDescriptorRepresentable {
        let chart: PrototypeChartModel
        let title: String

        func makeChartDescriptor() -> AXChartDescriptor {
            let slots = chart.series.map(\.points.count).max() ?? 0
            let xAxis = AXNumericDataAxisDescriptor(
                title: "Point", range: 0 ... Double(Swift.max(slots - 1, 1)), gridlinePositions: []
            ) { "\(Int($0) + 1)" }
            let yAxis = AXNumericDataAxisDescriptor(
                title: "Value", range: chart.yMin ... chart.yMax, gridlinePositions: []
            ) { PrototypeChart.format($0) }
            let series = chart.series.map { entry in
                AXDataSeriesDescriptor(
                    name: entry.label,
                    isContinuous: chart.variant != "bar",
                    dataPoints: entry.points.enumerated().map { AXDataPoint(x: Double($0.offset), y: $0.element.y) }
                )
            }
            return AXChartDescriptor(
                title: title, summary: chart.summary, xAxis: xAxis, yAxis: yAxis,
                additionalAxes: [], series: series
            )
        }

        func updateChartDescriptor(_ descriptor: AXChartDescriptor) {
            let fresh = makeChartDescriptor()
            descriptor.title = fresh.title
            descriptor.summary = fresh.summary
            descriptor.xAxis = fresh.xAxis
            descriptor.yAxis = fresh.yAxis
            descriptor.series = fresh.series
        }
    }
#endif
