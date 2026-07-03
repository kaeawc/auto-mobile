import CoreGraphics
import XCTest

@testable import CtrlProxy

/// Unit tests for the platform-agnostic pinch public-API fallback math.
///
/// These exercise the decision that keeps `pinchOn` working (center-less) when
/// the private XCTest event-synthesis symbols are unavailable — see issue #2910.
/// The real iOS `app.pinch(withScale:velocity:)` call cannot run off-device, so
/// the geometry → scale/velocity mapping is extracted here to be verifiable.
final class PinchFallbackTests: XCTestCase {
    private let accuracy: CGFloat = 0.0001

    func testZoomInProducesScaleAboveOneAndPositiveVelocity() {
        let params = PinchFallback.parameters(distanceStart: 40, distanceEnd: 120, duration: 0.3)
        // distanceEnd/distanceStart = 3.0 → zoom in
        XCTAssertEqual(params.scale, 3.0, accuracy: accuracy)
        XCTAssertGreaterThan(params.velocity, 0, "zoom-in must use positive velocity")
    }

    func testZoomOutProducesScaleBelowOneAndNegativeVelocity() {
        let params = PinchFallback.parameters(distanceStart: 120, distanceEnd: 40, duration: 0.3)
        // distanceEnd/distanceStart ≈ 0.333 → zoom out
        XCTAssertEqual(params.scale, 1.0 / 3.0, accuracy: accuracy)
        XCTAssertLessThan(params.velocity, 0, "zoom-out must use negative velocity")
    }

    func testVelocityScalesWithDuration() {
        // A shorter duration must yield a larger-magnitude velocity for the same scale.
        let fast = PinchFallback.parameters(distanceStart: 40, distanceEnd: 120, duration: 0.2)
        let slow = PinchFallback.parameters(distanceStart: 40, distanceEnd: 120, duration: 1.0)
        XCTAssertGreaterThan(abs(fast.velocity), abs(slow.velocity))
    }

    func testNonPositiveDistanceStartDoesNotDivideByZero() {
        let params = PinchFallback.parameters(distanceStart: 0, distanceEnd: 120, duration: 0.3)
        XCTAssertTrue(params.scale.isFinite)
        XCTAssertTrue(params.velocity.isFinite)
        XCTAssertGreaterThan(params.scale, 0)
    }

    func testNonPositiveDurationStillYieldsFiniteNonzeroVelocity() {
        let params = PinchFallback.parameters(distanceStart: 40, distanceEnd: 120, duration: 0)
        XCTAssertTrue(params.velocity.isFinite)
        XCTAssertNotEqual(params.velocity, 0)
    }

    func testNoOpPinchStillYieldsNonzeroVelocity() {
        // XCUITest rejects a zero velocity; a degenerate (equal-distance) pinch must
        // still produce valid, nonzero params.
        let params = PinchFallback.parameters(distanceStart: 80, distanceEnd: 80, duration: 0.3)
        XCTAssertEqual(params.scale, 1.0, accuracy: accuracy)
        XCTAssertNotEqual(params.velocity, 0)
        XCTAssertTrue(params.velocity.isFinite)
    }

    func testScaleClampedToPositiveRange() {
        // Absurd geometry must not produce a non-positive or infinite scale.
        let tiny = PinchFallback.parameters(distanceStart: 1_000_000, distanceEnd: 1, duration: 0.3)
        XCTAssertGreaterThan(tiny.scale, 0)
        XCTAssertTrue(tiny.scale.isFinite)
    }

    func testPathRawValues() {
        XCTAssertEqual(PinchGesturePath.eventPath.rawValue, "event-path")
        XCTAssertEqual(PinchGesturePath.elementAnchored.rawValue, "element-anchored")
    }
}
