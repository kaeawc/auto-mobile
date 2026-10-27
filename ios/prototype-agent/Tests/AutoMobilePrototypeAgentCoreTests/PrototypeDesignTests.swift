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
        // The renderer's Button styles, Slider and date/time DatePicker controls already exist.
        XCTAssertEqual(
            Set(contract.designCoverage.filter { $0.value.ios == "native" }.keys),
            ["button", "slider", "datePicker", "timePicker"]
        )
        for entry in contract.designCoverage.values {
            XCTAssertTrue(["native", "material", "neutral"].contains(entry.ios))
            XCTAssertTrue(["material", "neutral"].contains(entry.android))
            if entry.ios == "native" { XCTAssertTrue(entry.parts?.isEmpty ?? true) }
        }
    }
}
