@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// The Swift twin of Android's `PrototypeChartTest`: it replays the same shared fixture and checks
/// the same summaries, ranges and number format, so the two renderers describe a chart alike.
final class PrototypeChartTests: XCTestCase {
    private var fixture: Data {
        get throws {
            let repository = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
            return try Data(contentsOf: repository.appendingPathComponent(
                "test/fixtures/prototype-spec/valid/chart-variants.json"
            ))
        }
    }

    private func charts(data: [String: JSONValue]? = nil) throws -> [PrototypeChartModel] {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture)
        let shown = data ?? spec.data
        return try XCTUnwrap(spec.root.children).compactMap { $0.chartModel(data: shown) }
    }

    func testSharedFixtureMapsEachChartToTheAndroidSummary() throws {
        let models = try charts()
        XCTAssertEqual(models.map(\.summary), [
            "Line chart, Heart rate, 5 points, min 58, max 141, latest 72",
            "Area chart, Heart rate, 5 points, min 58, max 141, latest 72, goal 100",
            "Bar chart, Steps, 3 points, min 6200, max 10400, latest 10400; " +
                "Goal pace, 3 points, min 6200, max 10400, latest 10400, goal 10000",
            "Ring chart, Steps today, 6500 of 10000",
        ])
        XCTAssertEqual(models[0].yMin, 40)
        XCTAssertEqual(models[0].yMax, 160)
        XCTAssertEqual(models[0].shownXLabels, ["6:00", "18:00"])
        XCTAssertEqual(models[2].shownXLabels, ["Mon", "Tue", "Wed"])
        XCTAssertEqual(models[3].ringFraction, 0.65, accuracy: 1e-9)
    }

    func testAuthoredContentDescriptionWinsOverTheSummary() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture)
        let nodes = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(
            nodes[0].chartLabel(data: spec.data, state: [:]),
            "Line chart, Heart rate, 5 points, min 58, max 141, latest 72"
        )
        XCTAssertEqual(nodes[3].chartLabel(data: spec.data, state: [:]), "Steps today, 6500 of 10000")
    }

    func testADataWriteRereadsThePoints() throws {
        let after = try charts(data: ["today": .array([.object(["count": .number(10500)])]), "steps": .array([])])
        XCTAssertEqual(after[2].summary, "Bar chart, Steps, no points; Goal pace, no points, goal 10000")
        XCTAssertEqual(after[3].summary, "Ring chart, Steps today, 10500 of 10000")
        XCTAssertEqual(after[3].ringFraction, 1)
    }

    func testBrokenPointsAreSkippedAndTheAxisNeverCollapses() {
        let series = PrototypeChartSeries(path: "/points", x: "t", y: "y", label: "Load", color: nil)
        let data: [String: JSONValue] = ["points": .array([
            .object(["t": .number(1), "y": .number(3)]), .number(5),
            .object(["t": .string("b"), "y": .string("high")]),
            .object(["t": .number(2.5), "y": .number(3)]),
        ])]
        let chart = PrototypeChart.model(
            variant: "line", series: [series], yRange: nil, goal: nil, xLabels: nil, data: data
        )
        XCTAssertEqual(chart.series[0].points.map(\.x), ["1", "2.5"])
        XCTAssertEqual(chart.yMin, 2)
        XCTAssertEqual(chart.yMax, 4)
        XCTAssertEqual(chart.summary, "Line chart, Load, 2 points, min 3, max 3, latest 3")
    }

    func testBarsRiseFromZeroAndAMissingPathIsAnEmptySeries() {
        let series = PrototypeChartSeries(path: "/points", x: nil, y: "y", label: "Load", color: nil)
        let bars = PrototypeChart.model(
            variant: "bar", series: [series], yRange: nil, goal: nil, xLabels: nil,
            data: ["points": .array([.object(["y": .number(4)])])]
        )
        XCTAssertEqual(bars.yMin, 0)
        let missing = PrototypeChart.model(
            variant: "bar", series: [series], yRange: nil, goal: nil, xLabels: nil, data: nil
        )
        XCTAssertEqual(missing.summary, "Bar chart, Load, no points")
    }

    func testNumbersReadWithAtMostTwoDecimalsRoundingHalvesAway() {
        XCTAssertEqual(
            [72.0, 72.5, 1.0 / 3, -1.0, -0.0, 1e6, 0.125, -0.125, 2.675, 0.375].map(PrototypeChart.format),
            ["72", "72.5", "0.33", "-1", "0", "1000000", "0.13", "-0.13", "2.67", "0.38"]
        )
    }

    func testRepeatBindsTheSeriesPathPerRow() throws {
        let spec = """
        {"id":"r","window":{"placement":{"type":"fullscreen"}},
         "data":{"rows":[{"key":"a"}],"a":[{"y":1},{"y":3}]},
         "root":{"type":"column","repeat":{"items":{"path":"/rows"},"as":"row","key":"key"},
           "children":[{"type":"chart","variant":"line",
             "series":[{"path":"/{row.key}","y":"y","label":"A"}]}]}}
        """
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: Data(spec.utf8))
        let chart = try XCTUnwrap(decoded.root.children?.first)
        XCTAssertEqual(chart.chartModel(data: decoded.data)?.summary, "Line chart, A, 2 points, min 1, max 3, latest 3")
    }
}
