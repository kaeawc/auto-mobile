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

    func testOuterShadowMarginIsZeroWithoutLayers() {
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([]), 0)
    }

    func testOuterShadowMarginIncludesBlurAndOffset() {
        let layer = PrototypeStyleShadowLayer(color: nil, sigma: 12, spread: 0, x: 0, y: 14, inner: false)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([layer]), 63)
    }

    func testInnerShadowsDoNotContributeToOuterMargin() {
        let inner = PrototypeStyleShadowLayer(color: nil, sigma: 100, spread: 20, x: 30, y: 40, inner: true)
        let outer = PrototypeStyleShadowLayer(color: nil, sigma: 2, spread: 0, x: 0, y: 0, inner: false)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([inner]), 0)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([outer, inner]), 9)
    }

    func testOuterShadowMarginGrowsWithOffsetAndEitherSpreadDirection() {
        let base = PrototypeStyleShadowLayer(color: nil, sigma: 2, spread: 0, x: 0, y: 0, inner: false)
        let offset = PrototypeStyleShadowLayer(color: nil, sigma: 2, spread: 0, x: -3, y: 4, inner: false)
        let expanded = PrototypeStyleShadowLayer(color: nil, sigma: 2, spread: 6, x: -3, y: 4, inner: false)
        let contracted = PrototypeStyleShadowLayer(color: nil, sigma: 2, spread: -6, x: 3, y: -4, inner: false)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([base]), 9)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([offset]), 16)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([expanded]), 22)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([contracted]), 22)
    }

    func testOuterShadowMarginUsesLargestLayerRegardlessOfOrder() {
        let small = PrototypeStyleShadowLayer(color: nil, sigma: 2, spread: 0, x: 0, y: 0, inner: false)
        let large = PrototypeStyleShadowLayer(color: nil, sigma: 12, spread: 0, x: 0, y: 14, inner: false)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([small, large]), 63)
        XCTAssertEqual(PrototypeStyleShadowLayer.outerMargin([large, small]), 63)
    }
}
