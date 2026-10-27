@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeGlassTests: XCTestCase {
    func testRealGlassDecisionAndAdvertisement() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        for version in [17, 18, 25, 26, 27] {
            let expected = version >= 26
            XCTAssertEqual(PrototypeGlass.rendersGlass(osMajor: version), expected)
            XCTAssertEqual(
                PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: version))
                    .contains("prototype_glass_v1"),
                expected
            )
            XCTAssertTrue(
                PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: version))
                    .contains("prototype_scroll_edge_effect_v1")
            )
        }
    }

    func testEdgeFadeFallbackReusesAuthoredLengthsAndAxis() {
        XCTAssertEqual(PrototypeGlass.edgeFades(effect: "soft", axis: nil, authored: nil)?.top, 24)
        XCTAssertEqual(PrototypeGlass.edgeFades(effect: "hard", axis: "horizontal", authored: nil)?.start, 8)
        let authored = FadeEdges(top: 12, bottom: nil, start: nil, end: nil)
        XCTAssertEqual(PrototypeGlass.edgeFades(effect: "soft", axis: nil, authored: authored), authored)
        XCTAssertNil(PrototypeGlass.edgeFades(effect: "none", axis: nil, authored: authored))
        XCTAssertNil(PrototypeGlass.edgeFades(effect: nil, axis: nil, authored: nil))
    }
}
