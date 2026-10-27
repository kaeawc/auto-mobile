@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeDesignTests: XCTestCase {
    private func spec(_ design: String?) throws -> PrototypeSpec {
        let theme = design.map { #", "theme":{"design":"\#($0)"}"# } ?? ""
        let json = #"""
        {"id":"design","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"text","text":"Hi"}\#(theme)}
        """#
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    func testDefaultAndExplicitDesign() throws {
        var session = PrototypeSession()
        XCTAssertEqual(session.design, .platform)
        try session.show(spec("material"))
        XCTAssertEqual(session.design, .material)
        try session.show(spec("platform"))
        XCTAssertEqual(session.design, .platform)
        try session.show(spec(nil))
        XCTAssertEqual(session.design, .platform)
        XCTAssertEqual(try spec(nil).theme?.design ?? .platform, .platform)
        XCTAssertEqual(try spec("platform").theme?.design, .platform)
        XCTAssertEqual(try spec("material").theme?.design, .material)
        XCTAssertThrowsError(try spec("unknown"))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_design_platform_v1"))
    }

    func testSharedDesignFixtures() throws {
        for design in ["material", "platform"] {
            let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/design-\(design).json")
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: data)
            XCTAssertEqual(decoded.theme?.design?.rawValue, design)
        }
    }

    func testCoverageMatchesCoreVocabularyAndExistingSwiftUIControls() throws {
        struct Coverage: Decodable {
            let ios: String
            let android: String
            let parts: [String]?
        }
        struct Contract: Decodable {
            let designCoverage: [String: Coverage]
            let definitions: [String: JSONValue]
        }
        let contract = try JSONDecoder().decode(Contract.self, from: Data(prototypeSpecContractData.utf8))
        let variants = try XCTUnwrap(contract.definitions["node"]?.objectFields?["variants"]?.objectFields)
        XCTAssertEqual(Set(contract.designCoverage.keys), Set(variants.keys))
        for (type, entry) in contract.designCoverage {
            XCTAssertTrue(["native", "material", "neutral"].contains(entry.ios))
            XCTAssertTrue(["material", "neutral"].contains(entry.android))
            if entry.ios == "native" {
                let parts = try XCTUnwrap(PrototypeComponentLook.registeredParts[type])
                XCTAssertFalse(parts.isEmpty)
                XCTAssertEqual(entry.parts, parts)
                XCTAssertEqual(PrototypeComponentLook.resolve(type: type, design: nil), .platform)
                XCTAssertEqual(PrototypeComponentLook.resolve(type: type, design: .material), .material)
                for part in parts {
                    XCTAssertEqual(PrototypeComponentLook.identifier(testTag: "tag", part: part), "tag")
                    XCTAssertNil(PrototypeComponentLook.identifier(testTag: nil, part: part))
                }
                XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities().contains(
                    PrototypeComponentLook.capability(for: type)
                ))
            } else {
                XCTAssertEqual(PrototypeComponentLook.resolve(type: type, design: .platform), .material)
            }
        }
        XCTAssertEqual(
            Set(PrototypeComponentLook.registeredParts.keys),
            Set(contract.designCoverage.filter { $0.value.ios == "native" }.keys)
        )
    }

    func testNativeCoverageAdvertisementUsesOSFiltering() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        let capability = PrototypeComponentLook.capability(for: "switch")
        let minimumOS = [capability: 26]
        let older = PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 17), minimumOS: minimumOS)
        XCTAssertFalse(older.contains(capability))
        XCTAssertTrue(older.contains(PrototypeComponentLook.capability(for: "button")))
        XCTAssertTrue(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 26), minimumOS: minimumOS)
                .contains(capability)
        )
        XCTAssertEqual(PrototypeComponentLook.resolve(type: "unregistered", design: .platform), .material)
    }

    func testToggleMotionPolicy() {
        XCTAssertEqual(PrototypeComponentLook.toggleDurationMs(profile: .off), 0)
        XCTAssertEqual(PrototypeComponentLook.toggleDurationMs(profile: .full), 300)
        XCTAssertEqual(PrototypeComponentLook.toggleDurationMs(profile: .reduced), 300)
    }

    func testPerItemFallbacksHaveReasons() {
        for type in ["segmentedButton", "tabBar", "bottomNav", "menu", "select"] {
            XCTAssertEqual(PrototypeComponentLook.coverage[type]?.ios, "material")
            XCTAssertFalse(PrototypeComponentLook.coverage[type]?.reason?.isEmpty ?? true)
        }
    }
}
