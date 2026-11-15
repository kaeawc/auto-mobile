@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// The location event summary (#16463) replays the fixture the TypeScript reference replays.
final class PrototypeLocationEventSummaryTests: XCTestCase {
    private var fixture: [String: JSONValue] {
        get throws {
            let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("test/fixtures/prototype-location/event-summary.json")
            return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).objectFields)
        }
    }

    func testSharedEventSummaryCases() throws {
        guard case let .array(cases)? = try fixture["cases"] else { return XCTFail("Expected cases") }
        XCTAssertFalse(cases.isEmpty)
        for raw in cases {
            let fields = try XCTUnwrap(raw.objectFields)
            let name = fields["name"]?.stringValue ?? "unnamed"
            let fix = try XCTUnwrap(fields["fix"]?.objectFields)
            XCTAssertEqual(PrototypeLocationEventSummary.of(fix), fields["expected"], name)
        }
    }

    func testFixWithoutNumericAccuracyOrBooleanApproximateHasNoSummary() {
        XCTAssertNil(PrototypeLocationEventSummary.of(["approximate": .bool(false)]))
        XCTAssertNil(PrototypeLocationEventSummary.of(["accuracyM": .string("12"), "approximate": .bool(false)]))
        XCTAssertNil(PrototypeLocationEventSummary.of(["accuracyM": .number(12), "approximate": .string("false")]))
    }
}
