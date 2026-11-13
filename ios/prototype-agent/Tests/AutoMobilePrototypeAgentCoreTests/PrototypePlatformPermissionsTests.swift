@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Parity with the TypeScript and Kotlin readers: all three read schemas/prototype-platform-permissions.json.
final class PrototypePlatformPermissionsTests: XCTestCase {
    private func canonical() throws -> [String: [String: [String: Any]]] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("schemas/prototype-platform-permissions.json")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        return try XCTUnwrap(object as? [String: [String: [String: Any]]])
    }

    func testNamesAreTheFileKeysInContractOrder() throws {
        let file = try canonical()
        XCTAssertEqual(Set(PrototypePlatformPermissions.names), Set(file.keys))
        XCTAssertEqual(PrototypePlatformPermissions.names.count, file.count)
        XCTAssertEqual(PrototypePlatformPermissions.names.first, "camera")
        XCTAssertEqual(PrototypePlatformPermissions.names.last, "speech")
    }

    func testEveryNameMatchesTheFile() throws {
        for (name, raw) in try canonical() {
            let mapping = try XCTUnwrap(PrototypePlatformPermissions.mapping(for: name), name)
            XCTAssertEqual(raw["android"]?["manifest"] as? [String], mapping.android.manifest, name)
            XCTAssertEqual(raw["android"]?["grant"] as? String, mapping.android.grant, name)
            XCTAssertEqual(raw["ios"]?["usageKey"] as? String, mapping.ios.usageKey, name)
            XCTAssertEqual(raw["ios"]?["simctlService"] as? String, mapping.ios.simctlService, name)
        }
    }

    func testKnownEntriesKeepTheirShape() throws {
        let notifications = try XCTUnwrap(PrototypePlatformPermissions.mapping(for: "notifications"))
        XCTAssertEqual(notifications.android.grant, "notifications")
        XCTAssertNil(notifications.ios.usageKey)
        XCTAssertNil(notifications.ios.simctlService)
        XCTAssertEqual(PrototypePlatformPermissions.mapping(for: "location")?.ios.simctlService, "location")
        XCTAssertNil(PrototypePlatformPermissions.mapping(for: "nope"))
    }
}
