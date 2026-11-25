@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// The status `/platform` redaction (#16463) replays the fixture the TypeScript reference replays.
final class PrototypeInspectPlatformRedactionTests: XCTestCase {
    private var fixture: [String: JSONValue] {
        get throws {
            let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("test/fixtures/prototype-location/inspect-redaction.json")
            return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)).objectFields)
        }
    }

    func testSharedInspectRedactionCases() throws {
        guard case let .array(cases)? = try fixture["cases"] else { return XCTFail("Expected cases") }
        XCTAssertFalse(cases.isEmpty)
        for raw in cases {
            let fields = try XCTUnwrap(raw.objectFields)
            let name = fields["name"]?.stringValue ?? "unnamed"
            let platform = try XCTUnwrap(fields["platform"]?.objectFields)
            let includeLocation = try XCTUnwrap(fields["includeLocation"]?.boolValue)
            XCTAssertEqual(
                .object(PrototypeInspectPlatformRedaction.redact(platform, includeLocation: includeLocation)),
                fields["expected"],
                name
            )
        }
    }
}
