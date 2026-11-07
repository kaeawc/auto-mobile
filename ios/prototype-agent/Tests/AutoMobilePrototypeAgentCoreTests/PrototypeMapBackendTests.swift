@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The map `backend` capabilities (#14309) come from node positions in both collectors.
final class PrototypeMapBackendTests: XCTestCase {
    private let backends: Set = ["prototype_platform_map_google_v1", "prototype_platform_map_maplibre_v1"]

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
    }

    private func found(_ name: String) throws -> (strict: Set<String>, bundle: Set<String>) {
        let data = try Data(contentsOf: fixtures.appendingPathComponent(name))
        let spec = try JSONDecoder().decode(JSONValue.self, from: data).objectFields ?? [:]
        let strict = PrototypeStrictCapabilities.required(spec).intersection(backends)
        let bundle = try Set(PrototypeBundleCapabilities.required(data)).intersection(backends)
        return (strict, bundle)
    }

    func testBothCollectorsRequireEachNonDefaultBackendAMapNodeNames() throws {
        let result = try found("map-backends.json")
        XCTAssertEqual(result.strict, backends)
        XCTAssertEqual(result.bundle, backends)
    }

    func testAMapShapedChannelLiteralIsDataAndNeedsNoBackend() throws {
        let result = try found("map-backend-channel-literal.json")
        XCTAssertEqual(result.strict, [])
        XCTAssertEqual(result.bundle, [])
    }
}
