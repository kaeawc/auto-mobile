@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// Cast event data (#14239) replays the fixture the TypeScript reference and Kotlin twin replay.
final class PrototypeCastEventsTests: XCTestCase {
    private var fixture: [String: JSONValue] {
        get throws {
            let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("test/fixtures/prototype-spec/cast/events.json")
            return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).objectFields)
        }
    }

    func testEventAndReasonListsMatchTheSharedFixture() throws {
        let fixture = try fixture
        XCTAssertEqual(fixture["events"], .array(PrototypeCastEvents.events.map(JSONValue.string)))
        XCTAssertEqual(fixture["failureReasons"], .array(PrototypeCastEvents.failureReasons.map(JSONValue.string)))
    }

    func testSharedCastEventFixture() throws {
        guard case let .array(cases)? = try fixture["cases"] else { return XCTFail("Expected cases") }
        for raw in cases {
            let fields = try XCTUnwrap(raw.objectFields)
            let name = fields["name"]?.stringValue ?? "unnamed"
            let event = try XCTUnwrap(fields["event"]?.stringValue)
            let data = try XCTUnwrap(fields["data"])
            var expected: PrototypeCastEvents.Event?
            if fields["valid"] == .bool(true) {
                let object = try XCTUnwrap(data.objectFields, name)
                expected = PrototypeCastEvents.Event(name: String(event.dropFirst("cast.".count)), data: object)
            }
            XCTAssertEqual(PrototypeCastEvents.decode(event, data), expected, name)
        }
    }
}
