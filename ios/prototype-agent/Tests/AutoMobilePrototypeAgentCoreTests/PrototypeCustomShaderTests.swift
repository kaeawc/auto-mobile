@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeCustomShaderTests: XCTestCase {
    private let spec =
        Data(
            #"{"id":"shader","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Effect","style":{"shader":{"asset":"effect","uniforms":{"strength":1}}}}}"#
                .utf8
        )

    func testSharedContractValidatesShapeAndNegotiatesCapability() throws {
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: spec))
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec, supportedCapabilities: []))
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(
            data: spec,
            supportedCapabilities: ["prototype_custom_shaders_v1"]
        ))
        let value = try JSONDecoder().decode(JSONValue.self, from: spec)
        XCTAssertEqual(PrototypeStrictCapabilities.required(value.objectFields ?? [:]), ["prototype_custom_shaders_v1"])
        XCTAssertFalse(PrototypeAgentProtocol.capabilities.contains("prototype_custom_shaders_v1"))
    }

    func testIOSDecoderExplicitlyRefusesShader() {
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: spec)) { error in
            XCTAssertTrue(String(describing: error).contains("refuse custom AGSL shaders"))
        }
    }

    func testBundleExplicitlyRefusesShaderAndMIME() {
        XCTAssertThrowsError(try PrototypeBundleReferences(spec)) { error in
            XCTAssertEqual((error as? PrototypeBundleFailure)?.code, .customShadersUnsupported)
            XCTAssertTrue(error.localizedDescription.contains("refuse custom AGSL shaders"))
        }
        let manifest = Data("""
        {"bundleFormatVersion":1,"specSha256":"\(String(
            repeating: "0",
            count: 64
        ))","assets":[{"id":"effect","file":"assets/effect.agsl","sha256":"\(String(
            repeating: "0",
            count: 64
        ))","mediaType":"application/vnd.automobile.agsl"}],"fonts":[],"requires":[]}
        """.utf8)
        XCTAssertThrowsError(try PrototypeBundleManifest(manifest)) { error in
            XCTAssertEqual((error as? PrototypeBundleFailure)?.code, .customShadersUnsupported)
        }
        XCTAssertEqual(PrototypeSavedLayoutLimits().maxShaderBytes, 16384)
    }
}
