@testable import AutoMobileHighlightCore
import QuartzCore
import XCTest

final class HandDrawnCircleTests: XCTestCase {
    func testAndroidGeometryAndPressureVariation() {
        let circle = HandDrawnCircle(random: { 0.5 })
        XCTAssertEqual(circle.startAngle, -90)
        let segments = circle.segments(in: CGRect(x: 10, y: 20, width: 100, height: 80))
        XCTAssertEqual(segments.count, 64)
        XCTAssertTrue(segments.allSatisfy { $0.strokeWidth >= 6 && $0.strokeWidth <= 16 })
        XCTAssertGreaterThan(segments[0].strokeWidth, segments[16].strokeWidth)
        XCTAssertFalse(segments[0].path.isEmpty)
    }

    func testStrokeUsesDevicePixelScaleAndFixedRed() throws {
        let layer = HandDrawnCircleLayer()
        layer.configure(rect: CGRect(x: 0, y: 0, width: 100, height: 80), strokeScale: 1.0 / 3)
        let strokes = try XCTUnwrap(layer.sublayers).compactMap { $0 as? CAShapeLayer }
        XCTAssertEqual(strokes.count, 64)
        XCTAssertTrue(strokes.allSatisfy { $0.lineWidth >= 2 && $0.lineWidth <= 16.0 / 3 })
        XCTAssertEqual(strokes[0].strokeColor, CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
    }

    func testAnimationDrawHoldAndStaggeredFade() {
        XCTAssertEqual(HandDrawnCircle.animation(elapsed: 0).progress, 0)
        XCTAssertEqual(HandDrawnCircle.animation(elapsed: 0.6).progress, 1)
        XCTAssertEqual(HandDrawnCircle.animation(elapsed: 0.6).alpha, 1)
        XCTAssertEqual(HandDrawnCircle.animation(elapsed: 1.2).alpha, 0)
        XCTAssertEqual(HandDrawnCircle.segmentAlpha(0, alpha: 0.5), 0)
        XCTAssertEqual(HandDrawnCircle.segmentAlpha(63, alpha: 0.5), 1)
    }

    func testRejectsOtherShapes() {
        for type in ["box", "path"] {
            let json = "{\"type\":\"\(type)\",\"bounds\":{\"x\":0,\"y\":0,\"width\":10,\"height\":10}}"
            XCTAssertThrowsError(try JSONDecoder().decode(CircleHighlight.self, from: Data(json.utf8)))
        }
    }
}
