import CoreGraphics
import ObjCExceptionCatcher
import XCTest

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

    // MARK: - Arc path (issue #12996)

    func testPureRotationKeepsAConstantRadiusAlongTheWholePath() {
        // A straight chord between start and end shrinks the radius to cos(rotation / 2) of the
        // original mid-gesture, so a rotation-only pinch zoomed.
        let segments = Int(ObjCExceptionCatcher_pinchSegmentCount(90))
        XCTAssertEqual(segments, 9)
        for index in 0 ... segments {
            let fingers = ObjCExceptionCatcher_computePinchFingersAt(
                200, 400, 100, 100, 90, CGFloat(index) / CGFloat(segments)
            )
            XCTAssertEqual(hypot(fingers.finger1.x - 200, fingers.finger1.y - 400), 50, accuracy: accuracy)
            XCTAssertEqual(hypot(fingers.finger2.x - 200, fingers.finger2.y - 400), 50, accuracy: accuracy)
        }
    }

    func testSegmentCountFollowsRotationMagnitudeAndIsBounded() {
        XCTAssertEqual(ObjCExceptionCatcher_pinchSegmentCount(0), 1)
        XCTAssertEqual(ObjCExceptionCatcher_pinchSegmentCount(5), 1)
        XCTAssertEqual(ObjCExceptionCatcher_pinchSegmentCount(-90), 9)
        XCTAssertEqual(ObjCExceptionCatcher_pinchSegmentCount(100_000), 36)
        XCTAssertEqual(ObjCExceptionCatcher_pinchSegmentCount(.nan), 1)
    }

    func testPathFractionsZeroAndOneEqualTheEndpointGeometry() {
        let points = ObjCExceptionCatcher_computePinchPoints(540, 960, 100, 300, 45)
        let start = ObjCExceptionCatcher_computePinchFingersAt(540, 960, 100, 300, 45, 0)
        let end = ObjCExceptionCatcher_computePinchFingersAt(540, 960, 100, 300, 45, 1)
        XCTAssertEqual(start.finger1.x, points.start1.x, accuracy: accuracy)
        XCTAssertEqual(start.finger1.y, points.start1.y, accuracy: accuracy)
        XCTAssertEqual(start.finger2.x, points.start2.x, accuracy: accuracy)
        XCTAssertEqual(start.finger2.y, points.start2.y, accuracy: accuracy)
        XCTAssertEqual(end.finger1.x, points.end1.x, accuracy: accuracy)
        XCTAssertEqual(end.finger1.y, points.end1.y, accuracy: accuracy)
        XCTAssertEqual(end.finger2.x, points.end2.x, accuracy: accuracy)
        XCTAssertEqual(end.finger2.y, points.end2.y, accuracy: accuracy)
    }

    /// SHARED PATH GOLDEN TABLE — the single source of truth is
    /// `test/fixtures/pinch-path-golden-vectors.json`; `test/parity/pinchGoldenVectorParity.test.ts`
    /// verifies this table and the Android mirror (`path golden vectors match iOS parity`) against
    /// it. Each row is (centerX, centerY, distanceStart, distanceEnd, rotationDegrees, fraction)
    /// followed by the expected *unordered* pair of finger positions at that fraction.
    func testPathGoldenVectorsMatchAndroidParity() {
        struct PathVector {
            let centerX: CGFloat
            let centerY: CGFloat
            let distanceStart: CGFloat
            let distanceEnd: CGFloat
            let rotationDegrees: CGFloat
            let fraction: CGFloat
            let expected: [CGPoint]
        }
        let pathVectors: [PathVector] = [
            PathVector(
                centerX: 200, centerY: 400, distanceStart: 100, distanceEnd: 100, rotationDegrees: 90, fraction: 0.5,
                expected: [CGPoint(x: 235.355339, y: 435.355339), CGPoint(x: 164.644661, y: 364.644661)]
            ),
            PathVector(
                centerX: 200, centerY: 400, distanceStart: 100, distanceEnd: 100, rotationDegrees: 90, fraction: 0.25,
                expected: [CGPoint(x: 246.193977, y: 419.134172), CGPoint(x: 153.806023, y: 380.865828)]
            ),
            PathVector(
                centerX: 300, centerY: 500, distanceStart: 200, distanceEnd: 80, rotationDegrees: -60, fraction: 0.5,
                expected: [CGPoint(x: 360.621778, y: 465), CGPoint(x: 239.378222, y: 535)]
            ),
            PathVector(
                centerX: 0, centerY: 0, distanceStart: 200, distanceEnd: 200, rotationDegrees: 0, fraction: 0.5,
                expected: [CGPoint(x: 100, y: 0), CGPoint(x: -100, y: 0)]
            ),
            PathVector(
                centerX: 540, centerY: 960, distanceStart: 100, distanceEnd: 300, rotationDegrees: 45, fraction: 1,
                expected: [CGPoint(x: 646.066017, y: 1066.066017), CGPoint(x: 433.933983, y: 853.933983)]
            ),
            PathVector(
                centerX: 540, centerY: 960, distanceStart: 100, distanceEnd: 300, rotationDegrees: 45, fraction: 0.5,
                expected: [CGPoint(x: 632.387953, y: 998.268343), CGPoint(x: 447.612047, y: 921.731657)]
            ),
        ]

        for vector in pathVectors {
            let fingers = ObjCExceptionCatcher_computePinchFingersAt(
                vector.centerX, vector.centerY, vector.distanceStart, vector.distanceEnd,
                vector.rotationDegrees, vector.fraction
            )
            let actual = sortedPoints([fingers.finger1, fingers.finger2])
            let expected = sortedPoints(vector.expected)
            for (actualPoint, expectedPoint) in zip(actual, expected) {
                XCTAssertEqual(actualPoint.x, expectedPoint.x, accuracy: accuracy, "x mismatch for \(vector)")
                XCTAssertEqual(actualPoint.y, expectedPoint.y, accuracy: accuracy, "y mismatch for \(vector)")
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
