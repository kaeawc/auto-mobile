@testable import AutoMobilePrototypeAgentCore
import XCTest

/// A marker `icon` that names an image asset (#16491) is carried by the bundle export.
final class PrototypeMapMarkerAssetTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
    }

    private func images(_ name: String) throws -> [String] {
        let data = try Data(contentsOf: fixtures.appendingPathComponent(name))
        return try PrototypeBundleReferences(data).images.map(\.string)
    }

    func testTheBundleListsAMarkerIconAsset() throws {
        XCTAssertEqual(try images("map-marker-asset-icon.json"), ["car-pin"])
    }

    func testAMaterialMarkerIconNameIsNotAnAsset() throws {
        XCTAssertEqual(try images("map-node.json"), [])
    }
}
