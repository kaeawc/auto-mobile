@testable import CtrlProxy
import XCTest

final class SpringBoardIconHitTests: XCTestCase {
    private func icon(_ label: String, _ frame: CGRect, identifier: String = "") -> SpringBoardIconHit.Icon {
        SpringBoardIconHit.Icon(identifier: identifier, label: label, frame: frame)
    }

    func testFindsTheIconUnderTheStartPoint() {
        let safari = icon("Safari", CGRect(x: 250, y: 1270, width: 72, height: 72))
        let maps = icon("Maps", CGRect(x: 400, y: 300, width: 72, height: 72))
        XCTAssertEqual(SpringBoardIconHit.candidates(at: CGPoint(x: 286, y: 1310), in: [maps, safari]), [safari])
    }

    func testAPointOffEveryIconHasNoCandidate() {
        let maps = icon("Maps", CGRect(x: 400, y: 300, width: 72, height: 72))
        XCTAssertEqual(SpringBoardIconHit.candidates(at: CGPoint(x: 600, y: 800), in: [maps]), [])
    }

    func testIgnoresZeroSizeIconsAndOrdersTheSmallestFirst() {
        let folder = icon("Utilities", CGRect(x: 0, y: 0, width: 200, height: 200))
        let inner = icon("Clock", CGRect(x: 10, y: 10, width: 60, height: 60))
        let hidden = icon("Hidden", CGRect(x: 0, y: 0, width: 0, height: 0))
        XCTAssertEqual(
            SpringBoardIconHit.candidates(at: CGPoint(x: 20, y: 20), in: [folder, hidden, inner]),
            [inner, folder]
        )
    }

    func testDisplayNamePrefersTheLabel() {
        XCTAssertEqual(SpringBoardIconHit.displayName(icon("Safari", .zero, identifier: "Safari-id")), "Safari")
        XCTAssertEqual(SpringBoardIconHit.displayName(icon("", .zero, identifier: "Safari-id")), "Safari-id")
        XCTAssertEqual(SpringBoardIconHit.displayName(icon("", .zero)), "a SpringBoard icon")
    }

    func testRefusalCarriesItsWireCode() {
        let error = GesturePerformer.GestureError.springBoardIconDrag(icon: "Safari")
        XCTAssertEqual(error.wireCode, "springboard_icon_drag")
        XCTAssertTrue(error.localizedDescription.contains("no input was sent"))
    }

    private func point(_ x: Double, _ y: Double, _ offsetMs: Int) -> PathGesturePoint {
        PathGesturePoint(x: x, y: y, offsetMs: offsetMs)
    }

    func testAZeroPressSwipeDoesNotHoldAtItsStart() {
        // input/swipe sends pressDurationMs 0: a home-screen page flick must not be refused.
        XCTAssertFalse(SpringBoardIconHit.dragHoldsAtStart(pressDuration: 0))
        XCTAssertFalse(SpringBoardIconHit.dragHoldsAtStart(pressDuration: 0.39))
    }

    func testAHeldDragHoldsAtItsStart() {
        // dragAndDrop presses for at least 600 ms, so it is still refused on an icon.
        XCTAssertTrue(SpringBoardIconHit.dragHoldsAtStart(pressDuration: 0.4))
        XCTAssertTrue(SpringBoardIconHit.dragHoldsAtStart(pressDuration: 0.6))
    }

    func testAPathThatMovesImmediatelyDoesNotHold() {
        XCTAssertFalse(SpringBoardIconHit.pathHoldsAtStart([point(300, 800, 0), point(50, 800, 300)]))
    }

    func testASparsePathIsInterpolatedAtTheSlopBoundary() {
        // 1000 pt over 1000 ms leaves the 10 pt slop after 10 ms, not at the second point's 1000 ms.
        XCTAssertFalse(SpringBoardIconHit.pathHoldsAtStart([point(0, 0, 0), point(1000, 0, 1000)]))
    }

    func testAPathThatDwellsAtItsStartHolds() {
        let held = [point(300, 800, 0), point(300, 800, 500), point(50, 800, 800)]
        XCTAssertTrue(SpringBoardIconHit.pathHoldsAtStart(held))
    }

    func testJitterWithinTheSlopStillCountsAsHolding() {
        let jitter = [point(300, 800, 0), point(304, 803, 200), point(306, 801, 450), point(80, 800, 700)]
        XCTAssertTrue(SpringBoardIconHit.pathHoldsAtStart(jitter))
    }

    func testAStationaryPathHoldsForItsWholeDuration() {
        XCTAssertTrue(SpringBoardIconHit.pathHoldsAtStart([point(300, 800, 0), point(300, 800, 400)]))
        XCTAssertFalse(SpringBoardIconHit.pathHoldsAtStart([point(300, 800, 0), point(300, 800, 100)]))
        XCTAssertFalse(SpringBoardIconHit.pathHoldsAtStart([]))
    }
}
