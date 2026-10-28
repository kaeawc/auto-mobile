@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeCardShapeTests: XCTestCase {
    func testCardUsesAuthoredUniformRadiusIncludingSquare() {
        XCTAssertEqual(PrototypeStyleCorners.cardRadius(.uniform(24), shapes: .standard), 24)
        XCTAssertEqual(PrototypeStyleCorners.cardRadius(.uniform(0), shapes: .standard), 0)
    }

    func testCardResolvesAuthoredTokenAgainstThemeShapes() {
        XCTAssertEqual(PrototypeStyleCorners.cardRadius(.token("large"), shapes: .standard), 16)
        XCTAssertEqual(
            PrototypeStyleCorners.cardRadius(.token("large"), shapes: PrototypeShapes(steps: [8, 12, 20, 28, 40])),
            28
        )
    }

    func testCardKeepsDefaultRadiusWithoutAuthoredUniformRadius() {
        XCTAssertEqual(PrototypeStyleCorners.cardRadius(nil, shapes: .standard), 12)
        XCTAssertEqual(
            PrototypeStyleCorners.cardRadius(
                .corners(topStart: 1, topEnd: 2, bottomEnd: 3, bottomStart: 4), shapes: .standard
            ),
            12
        )
    }

    func testCardContentIsNotClippedSoOutlineAndShadowSurvive() {
        XCTAssertFalse(PrototypeStyleCorners.clipsContent(nodeType: "card"))
    }

    func testOtherNodesKeepContentClipping() {
        for nodeType in ["box", "column", "row", "text", "image", "button", "chart", "listItem"] {
            XCTAssertTrue(PrototypeStyleCorners.clipsContent(nodeType: nodeType), nodeType)
        }
    }
}
