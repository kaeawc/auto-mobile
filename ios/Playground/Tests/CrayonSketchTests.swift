import CoreGraphics
import XCTest

@testable import Playground

/// Pins the hand-drawn crayon outline geometry (AC1), mirroring the Android
/// `CrayonSketchTest`: deterministic + seeded, bounded, closed exactly, and a
/// zero-roughness outline that lies on the rounded-rect perimeter.
final class CrayonSketchTests: XCTestCase {

    private let w: CGFloat = 200
    private let h: CGFloat = 96
    private let corner: CGFloat = 18
    private let roughness: CGFloat = 3

    func testSameSeedProducesIdenticalOutline() {
        let a = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 42, roughness: roughness)
        let b = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 42, roughness: roughness)
        XCTAssertEqual(a, b)
    }

    func testDifferentSeedProducesDifferentOutline() {
        let a = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 1, roughness: roughness)
        let b = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 2, roughness: roughness)
        XCTAssertNotEqual(a, b)
    }

    func testOutlineIsClosedExactly() {
        let pts = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 7, roughness: roughness)
        XCTAssertGreaterThanOrEqual(pts.count, 16)
        XCTAssertEqual(pts.first, pts.last)
    }

    func testEveryPointStaysWithinRoughnessBounds() {
        let pts = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 99, roughness: roughness)
        for p in pts {
            XCTAssertTrue(p.x >= -roughness - 0.001 && p.x <= w + roughness + 0.001, "x \(p.x) out of bounds")
            XCTAssertTrue(p.y >= -roughness - 0.001 && p.y <= h + roughness + 0.001, "y \(p.y) out of bounds")
        }
    }

    func testZeroRoughnessLiesOnPerimeter() {
        let pts = crayonOutlineOffsets(width: w, height: h, cornerRadius: corner, seed: 5, roughness: 0)
        for p in pts {
            XCTAssertTrue(onPerimeter(p), "point \(p) must lie on the rounded-rect perimeter")
        }
    }

    private func onPerimeter(_ p: CGPoint) -> Bool {
        let r = min(max(corner, 0), min(w, h) / 2)
        let eps: CGFloat = 0.05
        func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < eps }
        if near(p.y, 0) && p.x >= r - eps && p.x <= w - r + eps { return true }
        if near(p.y, h) && p.x >= r - eps && p.x <= w - r + eps { return true }
        if near(p.x, 0) && p.y >= r - eps && p.y <= h - r + eps { return true }
        if near(p.x, w) && p.y >= r - eps && p.y <= h - r + eps { return true }
        let centres = [CGPoint(x: r, y: r), CGPoint(x: w - r, y: r), CGPoint(x: r, y: h - r), CGPoint(x: w - r, y: h - r)]
        return centres.contains { c in abs(hypot(p.x - c.x, p.y - c.y) - r) < eps }
    }
}
