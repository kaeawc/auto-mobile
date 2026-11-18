@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeInboundLinkSchemesTests: XCTestCase {
    func testOnlyRegisteredPrototypeSchemesReachDelivery() throws {
        let schemes = ["AMP-demo", "com.app", "https", "automobile-proto", "amp-"]
        XCTAssertEqual(PrototypeInboundLinkSchemes.registered(schemes), ["amp-demo"])
        XCTAssertTrue(PrototypeInboundLinkSchemes.accepts(try XCTUnwrap(URL(string: "AMP-demo://post/41")), schemes: schemes))
        for url in ["com.app://cb?code=secret", "https://host/post/41", "amp-other://post/41", "file:///tmp/spec"] {
            XCTAssertFalse(PrototypeInboundLinkSchemes.accepts(try XCTUnwrap(URL(string: url)), schemes: schemes))
        }
    }

    func testLinksRequireInstalledDeliveryAndARegisteredPrototypeScheme() throws {
        let links = PrototypeAgentProtocol.linksCapability
        XCTAssertFalse(PrototypeAgentProtocol.advertisedCapabilities().contains(links))
        XCTAssertFalse(AutoMobilePrototypeCapabilities.supported.contains(links))
        XCTAssertEqual(PrototypeInboundLinkSchemes.capabilities(installed: false, schemes: ["amp-demo"]), [])
        XCTAssertEqual(PrototypeInboundLinkSchemes.capabilities(installed: true, schemes: []), [])
        XCTAssertEqual(PrototypeInboundLinkSchemes.capabilities(installed: true, schemes: ["com.app"]), [])
        let delivered = PrototypeInboundLinkSchemes.capabilities(installed: true, schemes: ["amp-demo"])
        XCTAssertEqual(delivered, [links])
        XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities(registryCapabilities: delivered).contains(links))
        let spec =
            Data(
                #"{"id":"links","window":{"placement":{"type":"fullscreen"}},"requires":["prototype_links_v1"],"links":[],"root":{"type":"text","text":"Links"}}"#
                    .utf8
            )
        XCTAssertThrowsError(try PrototypeEmbeddedSpec.load(data: spec)) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .unsupportedCapabilities([links]))
        }
        XCTAssertNoThrow(try PrototypeEmbeddedSpec.load(
            data: spec,
            supported: AutoMobilePrototypeCapabilities.supported + delivered
        ))
    }
}
