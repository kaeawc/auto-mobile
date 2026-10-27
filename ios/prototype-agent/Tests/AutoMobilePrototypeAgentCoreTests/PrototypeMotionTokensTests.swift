@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeMotionTokensTests: XCTestCase {
    override static func setUp() {
        super.setUp()
        _ = PrototypeMotionTokens.token(property: "scale")
    }

    func testRolesAndPhysicalSpring() {
        for property in [
            "offset",
            "scale",
            "rotation",
            "cornerRadius",
            "elevation",
            "shadowColor",
            "padding",
            "border.width",
            "width",
            "height",
        ] {
            XCTAssertEqual(PrototypeMotionTokens.role(property), "spatial")
            let token = PrototypeMotionTokens.token(scheme: "expressive", property: property)
            XCTAssertEqual(token.dampingRatio, 0.8)
            XCTAssertEqual(token.stiffness, 380)
            XCTAssertEqual(token.mass, 1)
            XCTAssertEqual(token.damping, 2 * 0.8 * sqrt(380), accuracy: 1e-6)
            XCTAssertTrue(token.overshoots)
        }
        for property in ["alpha", "background", "color", "border.color"] {
            XCTAssertEqual(PrototypeMotionTokens.role(property), "effects")
            for scheme in ["standard", "expressive"] {
                let token = PrototypeMotionTokens.token(scheme: scheme, property: property)
                XCTAssertFalse(token.overshoots)
                XCTAssertEqual(token.damping, 2 * sqrt(1600), accuracy: 1e-6)
            }
        }
    }

    func testEveryTempoUsesTheContract() {
        for scheme in ["standard", "expressive"] {
            for property in ["scale", "alpha"] {
                for tempo in ["fast", "default", "slow"] {
                    let token = PrototypeMotionTokens.token(scheme: scheme, property: property, tempo: tempo)
                    XCTAssertEqual(token.damping, 2 * token.dampingRatio * sqrt(token.stiffness), accuracy: 1e-6)
                }
            }
        }
    }

    func testDecodedNodeRetainsTempoAndTransforms() throws {
        let node = try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data(
                #"{"type":"text","text":"Hi","animate":{"tempo":"fast"},"style":{"scale":0.5,"rotation":30}}"#
                    .utf8
            )
        )
        XCTAssertEqual(node.animate?.tempo, "fast")
        XCTAssertEqual(node.style?.scale, 0.5)
        XCTAssertEqual(node.style?.rotation, 30)
    }
}
