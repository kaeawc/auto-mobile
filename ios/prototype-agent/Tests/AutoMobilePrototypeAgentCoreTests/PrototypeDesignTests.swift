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
        struct Variant: Decodable {}
        struct Node: Decodable { let variants: [String: Variant] }
        struct Definitions: Decodable { let node: Node }
        struct Contract: Decodable {
            let designCoverage: [String: Coverage]
            let definitions: Definitions
        }
        let contract = try JSONDecoder().decode(Contract.self, from: Data(prototypeSpecContractData.utf8))
        let variants = contract.definitions.node.variants
        XCTAssertEqual(Set(contract.designCoverage.keys), Set(variants.keys))
        let advertised = Set(PrototypeAgentProtocol.advertisedCapabilities())
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
                    let owner: PrototypeComponentLook.IdentifierOwner = ["switch", "checkbox"].contains(type)
                        ? .toggle : .renderer
                    XCTAssertEqual(PrototypeComponentLook.identifier(
                        type: type, design: .platform, testTag: "tag", owner: owner, part: part
                    ), "tag")
                    XCTAssertNil(PrototypeComponentLook.identifier(
                        type: type, design: .platform, testTag: nil, owner: owner, part: part
                    ))
                }
                XCTAssertTrue(advertised.contains(
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

    func testToggleCoverageIdentifierHasOneOwnerAcrossDesigns() {
        for type in ["switch", "checkbox"] {
            for design: PrototypeDesign? in [nil, .platform, .material] {
                let toggleOwns = design != .material
                XCTAssertEqual(PrototypeComponentLook.identifier(
                    type: type, design: design, testTag: "row", owner: .toggle
                ), toggleOwns ? "row" : nil)
                XCTAssertEqual(PrototypeComponentLook.identifier(
                    type: type, design: design, testTag: "row", owner: .renderer
                ), toggleOwns ? nil : "row")
            }
        }
    }

    /// SwiftPM excludes UIKit. Bind the pure ownership policy to both renderer call sites so
    /// removing either integration cannot leave a green identifier-only coverage assertion.
    func testToggleCoverageRendererUsesIdentifierOwnershipAndSingleRowTarget() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/AutoMobilePrototypeAgent")
        let renderer = try String(
            contentsOf: sources.appendingPathComponent("PrototypeRenderer.swift"),
            encoding: .utf8
        )
        let toggle = try String(
            contentsOf: sources.appendingPathComponent("PrototypeToggleView.swift"),
            encoding: .utf8
        )
        let compactRenderer = renderer.filter { !$0.isWhitespace }
        XCTAssertTrue(compactRenderer.contains("PrototypeComponentLook.identifier(type:node.type,"))
        XCTAssertTrue(compactRenderer.contains("testTag:node.testTag,owner:.renderer"))
        XCTAssertTrue(toggle.contains("identifier: PrototypeComponentLook.identifier("))
        XCTAssertTrue(toggle.contains("testTag: node.testTag, owner: .toggle"))
        XCTAssertTrue(toggle.contains("content.accessibilityIdentifier(identifier)"))
        XCTAssertTrue(toggle.contains(".toggleStyle(PrototypeRowToggleStyle("))
        XCTAssertTrue(toggle.contains("Button { configuration.isOn.toggle() }"))
        XCTAssertTrue(toggle.contains(".contentShape(Rectangle())"))
        XCTAssertTrue(toggle.contains(".allowsHitTesting(false)"))
        XCTAssertTrue(toggle.contains("if let label { content.accessibilityLabel(label) }"))
        XCTAssertFalse(toggle.contains(".accessibilityElement(children: .ignore)"))
        XCTAssertFalse(toggle.contains(".accessibilityLabel(node.label ??"))
        XCTAssertTrue(toggle.contains("configuration.isOn ? .isSelected : []"))
        XCTAssertTrue(toggle.contains("PrototypeComponentLook.toggleAccessibilityValue("))
    }

    func testToggleAccessibilityValuesPreserveCheckboxSemantics() {
        XCTAssertEqual(PrototypeComponentLook.toggleAccessibilityValue(type: "checkbox", isOn: true), "checked")
        XCTAssertEqual(PrototypeComponentLook.toggleAccessibilityValue(type: "checkbox", isOn: false), "unchecked")
        XCTAssertEqual(PrototypeComponentLook.toggleAccessibilityValue(type: "switch", isOn: true), "1")
        XCTAssertEqual(PrototypeComponentLook.toggleAccessibilityValue(type: "switch", isOn: false), "0")
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
