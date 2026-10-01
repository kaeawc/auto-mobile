@testable import CtrlProxyRewrite
import XCTest

final class SwipeVelocityTests: XCTestCase {
    func testVelocityScalesInverselyWithDuration() {
        let faster = GesturePerformer.swipeVelocity(distance: 600, duration: 0.3)
        let slower = GesturePerformer.swipeVelocity(distance: 600, duration: 0.6)

        XCTAssertEqual(faster, 2000)
        XCTAssertEqual(slower, 1000)
    }

    func testVelocityIsClampedAtBothEnds() {
        XCTAssertEqual(GesturePerformer.swipeVelocity(distance: 1000, duration: 0.01), 10000)
        XCTAssertEqual(GesturePerformer.swipeVelocity(distance: 1, duration: 100), 100)
    }

    func testInvalidDurationOrDistanceUsesDefaultVelocityFallback() {
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: 10, duration: 0))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: 10, duration: -1))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: 0, duration: 1))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: -1, duration: 1))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: .infinity, duration: 1))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: 10, duration: .infinity))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: .nan, duration: 1))
        XCTAssertNil(GesturePerformer.swipeVelocity(distance: 10, duration: .nan))
    }
}
