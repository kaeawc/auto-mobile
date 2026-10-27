@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeNamespaceTests: XCTestCase {
    func testGlassFallsBackBefore26() {
        for style in ["glass", "glassProminent"] {
            XCTAssertEqual(PrototypeNamespacePolicy.buttonStyle(style, osMajor: 25), "bordered")
            XCTAssertEqual(PrototypeNamespacePolicy.buttonStyle(style, osMajor: 26), style)
        }
        XCTAssertNil(PrototypeNamespacePolicy.buttonStyle(nil, osMajor: 26))
    }

    func testHoverIsRenderOnlyFrom17() {
        XCTAssertNil(PrototypeNamespacePolicy.hover("lift", osMajor: 16))
        XCTAssertEqual(PrototypeNamespacePolicy.hover("highlight", osMajor: 17), "highlight")
    }

    func testCustomChromeIsIgnored() throws {
        let data =
            Data(
                #"{"tab":{"role":"search"},"bottomAccessory":{"type":"text","text":"Playing"},"sheet":{"sizing":"fitted"},"navigationTitle":"large"}"#
                    .utf8
            )
        let namespace = try JSONDecoder().decode(IosNamespace.self, from: data)
        XCTAssertEqual(PrototypeNamespacePolicy.ignoredFields(namespace, isButton: false), [
            "tab.role", "bottomAccessory", "sheet.sizing", "navigationTitle",
        ])
    }

    func testNamespaceAdvertisedAtFloorWithNewerFieldFallbacks() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        XCTAssertFalse(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 16))
                .contains("prototype_platform_namespace_v1")
        )
        XCTAssertTrue(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 17))
                .contains("prototype_platform_namespace_v1")
        )
    }
}
