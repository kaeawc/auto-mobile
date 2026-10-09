@testable import AutoMobileOverlayAgentCore
import XCTest

/// A bottom sheet rides above the software keyboard like Android's (owner decision 2026-10-09).
final class OverlayKeyboardLiftTests: XCTestCase {
    private let keyboard = OverlayRect(x: 0, y: 500, width: 400, height: 300)

    private func lift(
        _ type: String = "sheet", edge: String? = "bottom", keyboard: OverlayRect?? = nil,
        originY: Double = 0, height: Double = 800
    )
        -> Double
    {
        OverlayKeyboardLift.amount(
            placementType: type, edge: edge, keyboardFrame: keyboard ?? self.keyboard,
            windowOriginY: originY, windowHeight: height
        )
    }

    func testBottomSheetRisesByTheKeyboardsOverlapWithTheWindow() {
        XCTAssertEqual(lift(), 300)
        XCTAssertEqual(lift(edge: nil), 300, "an absent edge is the bottom")
    }

    func testWindowOriginShiftsTheOverlap() {
        XCTAssertEqual(lift(originY: 20, height: 780), 300)
        XCTAssertEqual(lift(originY: 0, height: 700), 200, "a window that ends above the screen bottom")
    }

    func testOtherPlacementsNeverMove() {
        XCTAssertEqual(lift("fullscreen"), 0)
        XCTAssertEqual(lift("floating"), 0)
        XCTAssertEqual(lift("sheet", edge: "top"), 0)
        XCTAssertFalse(OverlayKeyboardLift.appliesTo(placementType: "floating", edge: "bottom"))
        XCTAssertTrue(OverlayKeyboardLift.appliesTo(placementType: "sheet", edge: nil))
    }

    func testNoKeyboardOrOneBelowTheWindowReturnsTheSheetToTheEdge() {
        XCTAssertEqual(lift(keyboard: .some(nil)), 0)
        XCTAssertEqual(lift(keyboard: OverlayRect(x: 0, y: 800, width: 400, height: 0)), 0, "hardware keyboard")
        XCTAssertEqual(lift(keyboard: OverlayRect(x: 0, y: 900, width: 400, height: 300)), 0, "hidden off screen")
    }

    func testLiftNeverExceedsTheWindow() {
        XCTAssertEqual(lift(keyboard: OverlayRect(x: 0, y: -50, width: 400, height: 900)), 800)
    }

    func testAnimationFollowsKeyboardDurationUnlessMotionIsOff() {
        let on = OverlayMotion(specMotion: nil, reduceMotion: false)
        XCTAssertEqual(OverlayKeyboardLift.animationDuration(keyboardDuration: 0.25, motion: on), 0.25)
        XCTAssertNil(OverlayKeyboardLift.animationDuration(keyboardDuration: nil, motion: on))
        XCTAssertNil(OverlayKeyboardLift.animationDuration(keyboardDuration: 0, motion: on))
        XCTAssertNil(OverlayKeyboardLift.animationDuration(
            keyboardDuration: 0.25, motion: OverlayMotion(specMotion: "none", reduceMotion: false)
        ))
        XCTAssertNil(OverlayKeyboardLift.animationDuration(
            keyboardDuration: 0.25, motion: OverlayMotion(specMotion: nil, reduceMotion: true)
        ))
    }

    func testSheetFrameMovesUpWithTheLiftAndStaysInTheWindow() {
        let raised = OverlaySheetFrame.rect(
            containerWidth: 400,
            containerHeight: 800,
            edge: "bottom",
            height: 200,
            lift: 300
        )
        XCTAssertEqual(raised, OverlayRect(x: 0, y: 300, width: 400, height: 200))
        let capped = OverlaySheetFrame.rect(
            containerWidth: 400,
            containerHeight: 800,
            edge: nil,
            height: 200,
            lift: 700
        )
        XCTAssertEqual(capped.y, 0)
        let top = OverlaySheetFrame.rect(containerWidth: 400, containerHeight: 800, edge: "top", height: 200, lift: 300)
        XCTAssertEqual(top.y, 0, "a top sheet ignores the lift")
    }
}
