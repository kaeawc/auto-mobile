@testable import CtrlProxyRewrite
import XCTest

final class ElementBoundsClampingTests: XCTestCase {
    func testClampedInt_mapsNaNToZeroAndInfinitiesToLimits() {
        let limit = Int(Int32.max)

        XCTAssertEqual(ElementBounds.clampedInt(.nan), 0)
        XCTAssertEqual(ElementBounds.clampedInt(.infinity), limit)
        XCTAssertEqual(ElementBounds.clampedInt(-.infinity), -limit)
    }

    func testClampedInt_clampsHugeFiniteValuesAndLimitEdges() {
        let limit = Int(Int32.max)
        let edge = CGFloat(limit)

        XCTAssertEqual(ElementBounds.clampedInt(1e300), limit)
        XCTAssertEqual(ElementBounds.clampedInt(-1e300), -limit)
        XCTAssertEqual(ElementBounds.clampedInt(edge), limit)
        XCTAssertEqual(ElementBounds.clampedInt(-edge), -limit)
        XCTAssertEqual(ElementBounds.clampedInt(edge + 1), limit)
        XCTAssertEqual(ElementBounds.clampedInt(-edge - 1), -limit)
        XCTAssertEqual(ElementBounds.clampedInt(edge - 0.5), limit - 1)
        XCTAssertEqual(ElementBounds.clampedInt(-edge + 0.5), -limit + 1)
    }

    func testClampedInt_preservesTruncationTowardZero() {
        let values: [CGFloat] = [0, 10.9, 20.9, 111.6, 71.1, -3.7, -0.9]
        for value in values {
            XCTAssertEqual(ElementBounds.clampedInt(value), Int(value))
        }
    }

    func testClamping_preservesOrdinaryFractionalFrame() {
        let frame = CGRect(x: 10.9, y: 20.9, width: 100.7, height: 50.2)
        let bounds = ElementBounds(clamping: frame)

        XCTAssertEqual(bounds.left, Int(frame.origin.x))
        XCTAssertEqual(bounds.top, Int(frame.origin.y))
        XCTAssertEqual(bounds.right, Int(frame.origin.x + frame.width))
        XCTAssertEqual(bounds.bottom, Int(frame.origin.y + frame.height))
        XCTAssertEqual([bounds.left, bounds.top, bounds.right, bounds.bottom], [10, 20, 111, 71])
    }

    func testClamping_preservesNegativeFractionalOrigins() {
        let bounds = ElementBounds(clamping: CGRect(x: -10.9, y: -20.9, width: 7.2, height: 9.6))

        XCTAssertEqual([bounds.left, bounds.top, bounds.right, bounds.bottom], [-10, -20, -3, -11])
    }

    func testClamping_mapsNaNOriginsAndSizesToZero() {
        let originFrame = CGRect(x: CGFloat.nan, y: CGFloat.nan, width: 10, height: 20)
        let originBounds = ElementBounds(clamping: originFrame)
        let sizeFrame = CGRect(x: 10, y: 20, width: CGFloat.nan, height: CGFloat.nan)
        let sizeBounds = ElementBounds(clamping: sizeFrame)

        XCTAssertEqual([originBounds.left, originBounds.top, originBounds.right, originBounds.bottom], [0, 0, 0, 0])
        XCTAssertEqual([sizeBounds.left, sizeBounds.top, sizeBounds.right, sizeBounds.bottom], [10, 20, 0, 0])
    }

    func testClamping_clampsInfiniteOriginsAndSizes() {
        let limit = Int(Int32.max)
        let originFrame = CGRect(x: CGFloat.infinity, y: -CGFloat.infinity, width: 10, height: 20)
        let originBounds = ElementBounds(clamping: originFrame)
        let sizeFrame = CGRect(x: 10, y: 20, width: CGFloat.infinity, height: -CGFloat.infinity)
        let sizeBounds = ElementBounds(clamping: sizeFrame)

        XCTAssertEqual(
            [originBounds.left, originBounds.top, originBounds.right, originBounds.bottom],
            [limit, -limit, limit, -limit]
        )
        XCTAssertEqual([sizeBounds.left, sizeBounds.top, sizeBounds.right, sizeBounds.bottom], [10, 20, limit, limit])
    }

    func testClamping_handlesNullAndInfiniteRects() {
        let limit = Int(Int32.max)
        let nullBounds = ElementBounds(clamping: .null)
        let frame = CGRect.infinite
        let infiniteBounds = ElementBounds(clamping: frame)

        XCTAssertEqual(
            [nullBounds.left, nullBounds.top, nullBounds.right, nullBounds.bottom],
            [limit, limit, limit, limit]
        )
        XCTAssertEqual(infiniteBounds.left, -limit)
        XCTAssertEqual(infiniteBounds.top, -limit)
        XCTAssertGreaterThanOrEqual(infiniteBounds.right, infiniteBounds.left)
        XCTAssertGreaterThanOrEqual(infiniteBounds.bottom, infiniteBounds.top)
    }

    func testClamping_clampsHugeFiniteFrameAndOverflowingSums() {
        let limit = Int(Int32.max)
        let hugeBounds = ElementBounds(clamping: CGRect(x: 1e300, y: -1e300, width: 1e300, height: 1e300))
        let magnitude = CGFloat.greatestFiniteMagnitude
        let overflowBounds = ElementBounds(clamping: CGRect(
            x: magnitude,
            y: magnitude,
            width: magnitude,
            height: magnitude
        ))

        XCTAssertEqual(
            [hugeBounds.left, hugeBounds.top, hugeBounds.right, hugeBounds.bottom],
            [limit, -limit, limit, 0]
        )
        XCTAssertEqual(
            [overflowBounds.left, overflowBounds.top, overflowBounds.right, overflowBounds.bottom],
            [limit, limit, limit, limit]
        )
    }

    func testClamping_mapsOpposingInfinitySumsToZero() {
        let limit = Int(Int32.max)
        let frame = CGRect(
            x: CGFloat.infinity,
            y: -CGFloat.infinity,
            width: -CGFloat.infinity,
            height: CGFloat.infinity
        )
        let bounds = ElementBounds(clamping: frame)

        XCTAssertEqual([bounds.left, bounds.top, bounds.right, bounds.bottom], [limit, -limit, limit, 0])
    }

    func testElementBounds_preservesMinMaxEdgesForNegativeSizes() {
        let frame = CGRect(x: 10.9, y: 20.9, width: -4.2, height: -5.8)
        let bounds = ElementLocator.elementBounds(frame)
        let rawBounds = ElementBounds(clamping: frame)

        XCTAssertEqual([bounds.left, bounds.top, bounds.right, bounds.bottom], [6, 15, 10, 20])
        XCTAssertEqual(
            [rawBounds.left, rawBounds.top, rawBounds.right, rawBounds.bottom],
            [
                Int(frame.origin.x),
                Int(frame.origin.y),
                Int(frame.origin.x + frame.width),
                Int(frame.origin.y + frame.height),
            ]
        )
    }

    func testElementBounds_clampsNullAndInfiniteEdges() {
        let limit = Int(Int32.max)
        let nullBounds = ElementLocator.elementBounds(.null)
        let infiniteBounds = ElementLocator.elementBounds(.infinite)

        XCTAssertEqual(
            [nullBounds.left, nullBounds.top, nullBounds.right, nullBounds.bottom],
            [limit, limit, limit, limit]
        )
        XCTAssertEqual(
            [infiniteBounds.left, infiniteBounds.top, infiniteBounds.right, infiniteBounds.bottom],
            [-limit, -limit, limit, limit]
        )
    }

    func testHasZeroArea_rejectsEveryNonFiniteComponent() {
        let values: [CGFloat] = [.nan, .infinity, -.infinity]
        for value in values {
            XCTAssertTrue(ElementLocator.hasZeroArea(CGRect(x: value, y: 20, width: 100, height: 50)))
            XCTAssertTrue(ElementLocator.hasZeroArea(CGRect(x: 10, y: value, width: 100, height: 50)))
            XCTAssertTrue(ElementLocator.hasZeroArea(CGRect(x: 10, y: 20, width: value, height: 50)))
            XCTAssertTrue(ElementLocator.hasZeroArea(CGRect(x: 10, y: 20, width: 100, height: value)))
        }
    }

    func testHasZeroArea_rejectsNullInfiniteAndEmptyFrames() {
        XCTAssertTrue(ElementLocator.hasZeroArea(.null))
        XCTAssertTrue(ElementLocator.hasZeroArea(.infinite))
        XCTAssertTrue(ElementLocator.hasZeroArea(.zero))
        XCTAssertTrue(ElementLocator.hasZeroArea(CGRect(x: 10, y: 20, width: 0, height: 50)))
        XCTAssertTrue(ElementLocator.hasZeroArea(CGRect(x: 10, y: 20, width: 100, height: 0)))
    }

    func testHasZeroArea_keepsFiniteFramesWithNegativeOrigins() {
        XCTAssertFalse(ElementLocator.hasZeroArea(CGRect(x: 10.9, y: 20.9, width: 100.7, height: 50.2)))
        XCTAssertFalse(ElementLocator.hasZeroArea(CGRect(x: -10.9, y: -20.9, width: 7.2, height: 9.6)))
        XCTAssertFalse(ElementLocator.hasZeroArea(CGRect(x: 1e300, y: -1e300, width: 100, height: 50)))
    }
}
