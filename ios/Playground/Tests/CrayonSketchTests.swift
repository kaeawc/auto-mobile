import CoreGraphics
import XCTest

@testable import Playground

/// Pins the hand-drawn crayon outline geometry (AC1), mirroring the Android
/// `CrayonSketchTest`: deterministic + seeded, bounded, closed exactly, and first
/// zero-roughness outline that lies on the rounded-rect perimeter.
final class CrayonSketchTests: XCTestCase {
    private let width: CGFloat = 200
    private let height: CGFloat = 96
    private let corner: CGFloat = 18
    private let roughness: CGFloat = 3

    func testSameSeedProducesIdenticalOutline() {
        let first = crayonOutlineOffsets(
            width: width,
            height: height,
            cornerRadius: corner,
            seed: 42,
            roughness: roughness
        )
        let second = crayonOutlineOffsets(
            width: width,
            height: height,
            cornerRadius: corner,
            seed: 42,
            roughness: roughness
        )
        XCTAssertEqual(first, second)
    }

    func testDifferentSeedProducesDifferentOutline() {
        let first = crayonOutlineOffsets(
            width: width,
            height: height,
            cornerRadius: corner,
            seed: 1,
            roughness: roughness
        )
        let second = crayonOutlineOffsets(
            width: width,
            height: height,
            cornerRadius: corner,
            seed: 2,
            roughness: roughness
        )
        XCTAssertNotEqual(first, second)
    }

    func testOutlineIsClosedExactly() {
        let pts = crayonOutlineOffsets(
            width: width,
            height: height,
            cornerRadius: corner,
            seed: 7,
            roughness: roughness
        )
        XCTAssertGreaterThanOrEqual(pts.count, 16)
        XCTAssertEqual(pts.first, pts.last)
    }

    func testEveryPointStaysWithinRoughnessBounds() {
        let pts = crayonOutlineOffsets(
            width: width,
            height: height,
            cornerRadius: corner,
            seed: 99,
            roughness: roughness
        )
        for point in pts {
            XCTAssertTrue(
                point.x >= -roughness - 0.001 && point.x <= width + roughness + 0.001,
                "x \(point.x) out of bounds"
            )
            XCTAssertTrue(
                point.y >= -roughness - 0.001 && point.y <= height + roughness + 0.001,
                "y \(point.y) out of bounds"
            )
        }
    }

    func testZeroRoughnessHasNoDuplicateSeamPoints() {
        // Each perimeter seam is sampled once: with no jitter only the closing point
        // (last == first) may repeat — no interior consecutive duplicates. A duplicated
        // arc/edge seam point would jitter independently and render as a knot.
        let pts = crayonOutlineOffsets(width: width, height: height, cornerRadius: corner, seed: 3, roughness: 0)
        for i in 1 ..< (pts.count - 1) {
            XCTAssertNotEqual(pts[i], pts[i - 1], "duplicate seam point at index \(i): \(pts[i])")
        }
    }

    func testNonPositiveSegmentsPerEdgeClampToOne() {
        // Zero or negative segmentsPerEdge must not crash and must behave like 1.
        let one = crayonOutlineOffsets(
            width: width, height: height, cornerRadius: corner, seed: 8, roughness: 0, segmentsPerEdge: 1
        )
        for bad in [0, -1, -7] {
            let got = crayonOutlineOffsets(
                width: width, height: height, cornerRadius: corner, seed: 8, roughness: 0, segmentsPerEdge: bad
            )
            XCTAssertEqual(got, one, "segmentsPerEdge \(bad) should clamp to 1")
        }
    }

    func testZeroRoughnessLiesOnPerimeter() {
        let pts = crayonOutlineOffsets(width: width, height: height, cornerRadius: corner, seed: 5, roughness: 0)
        for point in pts {
            XCTAssertTrue(onPerimeter(point), "point \(point) must lie on the rounded-rect perimeter")
        }
    }

    private func onPerimeter(_ point: CGPoint) -> Bool {
        let radius = min(max(corner, 0), min(width, height) / 2)
        let eps: CGFloat = 0.05
        func near(_ first: CGFloat, _ second: CGFloat) -> Bool { abs(first - second) < eps }
        if near(point.y, 0) && point.x >= radius - eps && point.x <= width - radius + eps { return true }
        if near(point.y, height) && point.x >= radius - eps && point.x <= width - radius + eps { return true }
        if near(point.x, 0) && point.y >= radius - eps && point.y <= height - radius + eps { return true }
        if near(point.x, width) && point.y >= radius - eps && point.y <= height - radius + eps { return true }
        let centres = [
            CGPoint(x: radius, y: radius),
            CGPoint(x: width - radius, y: radius),
            CGPoint(x: radius, y: height - radius),
            CGPoint(x: width - radius, y: height - radius),
        ]
        return centres.contains { center in abs(hypot(point.x - center.x, point.y - center.y) - radius) < eps }
    }
}
