@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeScrollMotionTests: XCTestCase {
    func testInterpolationAndClamping() {
        let range = [0.0, 160.0]
        XCTAssertEqual(PrototypeScrollMotion.interpolate(-20, range: range, output: [1, 0]), 1)
        XCTAssertEqual(PrototypeScrollMotion.interpolate(80, range: range, output: [1, 0]), 0.5)
        XCTAssertEqual(PrototypeScrollMotion.interpolate(200, range: range, output: [1, 0]), 0)
        XCTAssertEqual(PrototypeScrollMotion.interpolate(80, range: range, output: [0, -40]), -20)
    }

    func testReducedKeepsAlphaAndDropsSpatialOutputs() {
        let linked = ScrollLinked(
            source: "feed",
            range: [0, 160],
            alpha: [1, 0],
            scale: [1, 0.8],
            offsetY: [0, -40],
            offsetX: [0, 20],
            blur: [0, 8]
        )
        XCTAssertEqual(PrototypeScrollMotion.draw(linked, offset: 80, reduced: true), .init(alpha: 0.5))
        XCTAssertEqual(
            PrototypeScrollMotion.draw(linked, offset: 80, reduced: false),
            .init(alpha: 0.5, scale: 0.9, offsetX: 10, offsetY: -20, blur: 4)
        )
    }

    func testFiniteExtremesDoNotOverflow() {
        XCTAssertEqual(PrototypeScrollMotion.interpolate(0, range: [-1e308, 1e308], output: [-1e308, 1e308]), 0)
    }

    func testEdgeIsSymmetricAndClamps() {
        XCTAssertEqual(PrototypeScrollMotion.edge(0, value: 0.8, identity: 1), 1)
        XCTAssertEqual(PrototypeScrollMotion.edge(-0.5, value: 0.8, identity: 1), 0.9)
        XCTAssertEqual(PrototypeScrollMotion.edge(2, value: 0.8, identity: 1), 0.8)
    }
}
