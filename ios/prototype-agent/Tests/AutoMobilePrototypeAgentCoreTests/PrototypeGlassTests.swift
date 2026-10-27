@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeGlassTests: XCTestCase {
    func testRealGlassDecisionAndAdvertisement() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        for version in [17, 18, 25, 26, 27] {
            let expected = version >= 26
            XCTAssertFalse(
                PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: version))
                    .contains("prototype_platform_namespace_v1")
            )
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
        XCTAssertEqual(PrototypeGlass.edgeFades(effect: "none", axis: nil, authored: authored), authored)
        XCTAssertNil(PrototypeGlass.edgeFades(effect: "none", axis: nil, authored: nil))
        XCTAssertNil(PrototypeGlass.edgeFades(effect: nil, axis: nil, authored: nil))
    }

    func testBundleNamespaceRequirementsMatchTheSpecCorpus() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
        for (name, expected) in [
            ("glass-namespace-only", ["prototype_glass_v1"]),
            ("glass-namespace-mixed", ["prototype_glass_v1", "prototype_platform_namespace_v1"]),
        ] {
            let data = try Data(contentsOf: directory.appendingPathComponent("\(name).json"))
            XCTAssertEqual(try PrototypeBundleCapabilities.required(data), expected, name)
        }
    }
}
