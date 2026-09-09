import CoreGraphics
import ObjCExceptionCatcher
import XCTest

/// Pins the two-finger pinch endpoint geometry convention shared by the iOS and Android
/// runners (see issues #2911 / #2979). `rotationDegrees` describes how far the finger axis
/// rotates *during* the pinch: the axis starts horizontal (angle 0) and ends rotated by
/// `rotationDegrees`. This is a combined pinch+rotate, not a pinch along a fixed rotated axis.
///
/// Before #2979 the iOS side of this convention was guarded only by a human-maintained code
/// comment cross-referencing Android's `computePinchPoints`; nothing failed if the two
/// implementations silently diverged. `ObjCExceptionCatcher_computePinchPoints` extracts the
/// pure trig actually consumed by `ObjCExceptionCatcher_synthesizePinch` (the rewrite's
/// `GesturePerformer` calls it) so it is unit-testable off-device (the private XCTest
/// event-synthesis path cannot run in a macOS test host). This is the direct analog of
/// Android's `PinchGeometryTest`.
///
/// This file was carried into `CtrlProxyRewriteTests` when the reference `CtrlProxyTests`
/// target was retired in Phase 7E (#5834): the endpoint math (`ObjCExceptionCatcher`) is
/// unchanged and still shipping, so the cross-platform golden guard must keep exercising it.
/// `test/parity/pinchGoldenVectorParity.test.ts` reads this file's `let vectors: [Vector]`
/// golden table and its `ObjCExceptionCatcher_computePinchPoints` / `XCTAssertEqual` runtime
/// loop, so the marker text and the golden literals below are a cross-language contract.
///
/// The C function imports into Swift with positional (unlabeled) arguments; the argument order
/// is `(centerX, centerY, distanceStart, distanceEnd, rotationDegrees)`.
final class PinchGeometryTests: XCTestCase {
    private let accuracy: CGFloat = 1e-3

    // MARK: - Convention invariants (mirror of Android PinchGeometryTest)

    func testRadiiAreHalfTheRequestedDistances() {
        let points = ObjCExceptionCatcher_computePinchPoints(100, 200, 80, 300, 0)
        // Start axis horizontal: one finger sits startRadius to the right of center, the other
        // to the left. Labeling (start1 left / start2 right) is a runner detail; the set matters.
        XCTAssertEqual(points.start1.x, 100 - 40, accuracy: accuracy)
        XCTAssertEqual(points.start2.x, 100 + 40, accuracy: accuracy)
        // End radius is half of distanceEnd.
        XCTAssertEqual(points.end1.x, 100 - 150, accuracy: accuracy)
        XCTAssertEqual(points.end2.x, 100 + 150, accuracy: accuracy)
    }

    func testStartAxisIsAlwaysHorizontalRegardlessOfRotation() {
        let points = ObjCExceptionCatcher_computePinchPoints(540, 960, 100, 300, 45)
        // Start fingers stay on the horizontal axis (y == centerY) even when rotationDegrees != 0.
        XCTAssertEqual(points.start1.y, 960, accuracy: accuracy)
        XCTAssertEqual(points.start2.y, 960, accuracy: accuracy)
        XCTAssertEqual(points.start1.x, 540 - 50, accuracy: accuracy)
        XCTAssertEqual(points.start2.x, 540 + 50, accuracy: accuracy)
    }

    func testEndAxisIsRotatedByRotationDegrees() {
        let rotation: CGFloat = 45
        let points = ObjCExceptionCatcher_computePinchPoints(540, 960, 100, 300, rotation)
        let endRadius: CGFloat = 150
        let theta = rotation * CGFloat.pi / 180
        // End fingers lie on the axis rotated by `rotationDegrees` from horizontal, symmetric
        // about the center.
        XCTAssertEqual(points.end2.x, 540 + endRadius * cos(theta), accuracy: accuracy)
        XCTAssertEqual(points.end2.y, 960 + endRadius * sin(theta), accuracy: accuracy)
        XCTAssertEqual(points.end1.x, 540 - endRadius * cos(theta), accuracy: accuracy)
        XCTAssertEqual(points.end1.y, 960 - endRadius * sin(theta), accuracy: accuracy)
    }

    func testNegativeRotationRotatesTheEndAxisTheOppositeWay() {
        let rotation: CGFloat = -30
        let points = ObjCExceptionCatcher_computePinchPoints(200, 400, 100, 100, rotation)
        let radius: CGFloat = 50
        let theta = rotation * CGFloat.pi / 180
        // Sign of rotationDegrees must flow through to the end axis — cross-platform parity relies
        // on it. A negative angle puts the +offset finger's y below center.
        XCTAssertEqual(points.end2.y, 400 + radius * sin(theta), accuracy: accuracy)
        XCTAssertEqual(points.end2.x, 200 + radius * cos(theta), accuracy: accuracy)
        // Start axis stays horizontal regardless of the sign.
        XCTAssertEqual(points.start1.y, 400, accuracy: accuracy)
        XCTAssertEqual(points.start2.y, 400, accuracy: accuracy)
    }

    func testZeroRotationKeepsBothFingersOnTheHorizontalAxis() {
        let points = ObjCExceptionCatcher_computePinchPoints(0, 0, 200, 200, 0)
        // No rotation: start and end axes coincide, both horizontal — the common pinch/zoom case.
        XCTAssertEqual(points.start1.y, 0, accuracy: accuracy)
        XCTAssertEqual(points.end2.y, 0, accuracy: accuracy)
        XCTAssertEqual(points.end2.x, 100, accuracy: accuracy)
        XCTAssertEqual(points.end1.x, -100, accuracy: accuracy)
    }

    func testComputePinchPointsDoesNotClampDegenerateDistances() {
        // The pure function must NOT apply synthesizePinch's minimum-distance floor: a zero
        // distance yields radius 0, collapsing all four endpoints onto the center. The header
        // documents this contract (the floor lives in the synthesis wrapper). See #2979.
        let points = ObjCExceptionCatcher_computePinchPoints(320, 480, 0, 0, 45)
        for point in [points.start1, points.start2, points.end1, points.end2] {
            XCTAssertEqual(point.x, 320, accuracy: accuracy)
            XCTAssertEqual(point.y, 480, accuracy: accuracy)
        }
    }

    // MARK: - Cross-platform golden parity (issue #2979, Option 2)

    /// SHARED GOLDEN TABLE — the single source of truth is `test/fixtures/pinch-golden-vectors.json`;
    /// `test/parity/pinchGoldenVectorParity.test.ts` verifies this table and the Android mirror
    /// (`PinchGeometryTest.kt`'s `golden vectors match iOS parity`) against it. Each row is an input
    /// tuple and its expected *unordered* set of four endpoints (start1, start2, end1, end2). We
    /// compare as an order-independent set because the two runners label which finger is "first"
    /// oppositely (iOS builds center∓offset first, Android center±offset first) while producing the
    /// same two touch points. If either platform's endpoint math changes, its golden assertion fails
    /// loudly here or in the Kotlin mirror. If the two tables silently diverge — including a
    /// coordinated one-sided convention edit (change math + golden on one platform only) — the
    /// parity guard fails. Edit the JSON and both platform tables together. See #2911 / #2979 / #2997.
    func testGoldenVectorsMatchAndroidParity() {
        struct Vector {
            let centerX: CGFloat
            let centerY: CGFloat
            let distanceStart: CGFloat
            let distanceEnd: CGFloat
            let rotationDegrees: CGFloat
            let expected: [CGPoint]
        }
        let vectors: [Vector] = [
            Vector(
                centerX: 100, centerY: 200, distanceStart: 80, distanceEnd: 300, rotationDegrees: 0,
                expected: [
                    CGPoint(x: 60, y: 200), CGPoint(x: 140, y: 200),
                    CGPoint(x: -50, y: 200), CGPoint(x: 250, y: 200),
                ]
            ),
            Vector(
                centerX: 540, centerY: 960, distanceStart: 100, distanceEnd: 300, rotationDegrees: 45,
                expected: [
                    CGPoint(x: 490, y: 960), CGPoint(x: 590, y: 960),
                    CGPoint(x: 433.933983, y: 853.933983),
                    CGPoint(x: 646.066017, y: 1066.066017),
                ]
            ),
            Vector(
                centerX: 200, centerY: 400, distanceStart: 100, distanceEnd: 100, rotationDegrees: -30,
                expected: [
                    CGPoint(x: 150, y: 400), CGPoint(x: 250, y: 400),
                    CGPoint(x: 156.698730, y: 425), CGPoint(x: 243.301270, y: 375),
                ]
            ),
            // A second asymmetric negative angle so drop-rotation-sign / sin-cos-swap detection is
            // not a single point of failure on the -30 row (the +45 / rot-0 rows are blind to a
            // dropped sign). distanceStart != distanceEnd also exercises unequal radii.
            Vector(
                centerX: 300, centerY: 500, distanceStart: 200, distanceEnd: 80, rotationDegrees: -60,
                expected: [
                    CGPoint(x: 200, y: 500), CGPoint(x: 400, y: 500),
                    CGPoint(x: 280, y: 534.641016), CGPoint(x: 320, y: 465.358984),
                ]
            ),
            Vector(
                centerX: 0, centerY: 0, distanceStart: 200, distanceEnd: 200, rotationDegrees: 0,
                expected: [
                    CGPoint(x: -100, y: 0), CGPoint(x: 100, y: 0),
                    CGPoint(x: -100, y: 0), CGPoint(x: 100, y: 0),
                ]
            ),
        ]

        for vector in vectors {
            let points = ObjCExceptionCatcher_computePinchPoints(
                vector.centerX, vector.centerY,
                vector.distanceStart, vector.distanceEnd, vector.rotationDegrees
            )
            let actual = sortedPoints([points.start1, points.start2, points.end1, points.end2])
            let expected = sortedPoints(vector.expected)
            for (actualPoint, expectedPoint) in zip(actual, expected) {
                XCTAssertEqual(
                    actualPoint.x, expectedPoint.x, accuracy: accuracy,
                    "x mismatch for center (\(vector.centerX),\(vector.centerY)) rot \(vector.rotationDegrees)"
                )
                XCTAssertEqual(
                    actualPoint.y, expectedPoint.y, accuracy: accuracy,
                    "y mismatch for center (\(vector.centerX),\(vector.centerY)) rot \(vector.rotationDegrees)"
                )
            }
        }
    }

    /// Deterministic order-independent sort so the golden comparison ignores finger labeling.
    /// Uses exact (x, then y) ordering — identical to the Kotlin mirror's
    /// `compareBy({ it.first }, { it.second })` — so the two platforms can never sort the same
    /// point set into different orders. Golden inputs keep x-values separated well beyond the
    /// comparison tolerance, so exact ordering is stable.
    private func sortedPoints(_ points: [CGPoint]) -> [CGPoint] {
        points.sorted { lhs, rhs in
            lhs.x != rhs.x ? lhs.x < rhs.x : lhs.y < rhs.y
        }
    }
}
