import XCTest

@testable import Playground

final class TapAtTargetLayoutTests: XCTestCase {
    private let canvasSize = CGSize(width: 390, height: 600)

    func testTargetsHaveExpectedCountAndSizes() {
        let targets = TapAtTargetLayout.targets(in: canvasSize)

        XCTAssertEqual(targets.count, 11)
        XCTAssertEqual(
            targets.map(\.rect.size),
            [
                CGSize(width: 120, height: 120),
                CGSize(width: 88, height: 88),
                CGSize(width: 44, height: 44),
                CGSize(width: 32, height: 32),
                CGSize(width: 24, height: 24),
                CGSize(width: 16, height: 16),
                CGSize(width: 10, height: 10),
                CGSize(width: 6, height: 6),
                CGSize(width: 64, height: 8),
                CGSize(width: 8, height: 64),
                CGSize(width: 36, height: 36),
            ]
        )
    }

    func testResolutionDistinguishesInsideAndOutsidePoints() throws {
        let targets = TapAtTargetLayout.targets(in: canvasSize)
        let target = try XCTUnwrap(targets.first)

        let inside = TapAtTargetLayout.resolve(target.center, against: targets)
        let outside = TapAtTargetLayout.resolve(CGPoint(x: 195, y: 340), against: targets)

        XCTAssertEqual(inside?.hitTargetID, target.id)
        XCTAssertNil(outside?.hitTargetID)
        XCTAssertNotNil(outside?.nearestTargetID)
    }

    func testDistanceUsesTargetCenter() throws {
        let target = try XCTUnwrap(TapAtTargetLayout.targets(in: canvasSize).first)
        let point = CGPoint(x: target.center.x + 3, y: target.center.y + 4)

        XCTAssertEqual(TapAtTargetLayout.distance(from: point, to: target), 5, accuracy: 0.001)
    }

    func testCircleRejectsCornersOfItsBoundingBox() throws {
        let targets = TapAtTargetLayout.targets(in: canvasSize)
        let circle = try XCTUnwrap(targets.first(where: { $0.id == "T11" }))
        let corner = CGPoint(x: circle.rect.minX + 1, y: circle.rect.minY + 1)

        XCTAssertEqual(TapAtTargetLayout.resolve(circle.center, against: targets)?.hitTargetID, "T11")
        XCTAssertNil(TapAtTargetLayout.resolve(corner, against: targets)?.hitTargetID)
    }

    func testSummaryFormatsPartialCompleteAndAllMissStates() {
        XCTAssertEqual(
            TapAtTargetLayout.summary(hitTargetIDs: ["T1", "T2"], backgroundMisses: 3),
            "hits: 2/11, misses: [T3, T4, T5, T6, T7, T8, T9, T10, T11], background misses: 3"
        )
        XCTAssertEqual(
            TapAtTargetLayout.summary(hitTargetIDs: Set((1 ... 11).map { "T\($0)" }), backgroundMisses: 0),
            "hits: 11/11, misses: [], background misses: 0"
        )
        XCTAssertEqual(
            TapAtTargetLayout.summary(hitTargetIDs: [], backgroundMisses: 0),
            "hits: 0/11, misses: [T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11], background misses: 0"
        )
    }
}
