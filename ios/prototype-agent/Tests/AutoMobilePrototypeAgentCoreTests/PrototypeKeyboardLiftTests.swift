@testable import AutoMobilePrototypeAgentCore
import XCTest

/// A bottom sheet rides above the software keyboard like Android's (owner decision 2026-10-09).
final class PrototypeKeyboardLiftTests: XCTestCase {
    private let keyboard = PrototypeRect(x: 0, y: 500, width: 400, height: 300)

    private func lift(
        _ type: String = "sheet", edge: String? = "bottom", keyboard: PrototypeRect?? = nil,
        originY: Double = 0, height: Double = 800
    )
        -> Double
    {
        PrototypeKeyboardLift.amount(
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
        XCTAssertFalse(PrototypeKeyboardLift.appliesTo(placementType: "floating", edge: "bottom"))
        XCTAssertTrue(PrototypeKeyboardLift.appliesTo(placementType: "sheet", edge: nil))
    }

    func testNoKeyboardOrOneBelowTheWindowReturnsTheSheetToTheEdge() {
        XCTAssertEqual(lift(keyboard: .some(nil)), 0)
        XCTAssertEqual(lift(keyboard: PrototypeRect(x: 0, y: 800, width: 400, height: 0)), 0, "hardware keyboard")
        XCTAssertEqual(lift(keyboard: PrototypeRect(x: 0, y: 900, width: 400, height: 300)), 0, "hidden off screen")
    }

    func testLiftNeverExceedsTheWindow() {
        XCTAssertEqual(lift(keyboard: PrototypeRect(x: 0, y: -50, width: 400, height: 900)), 800)
    }

    func testAnimationFollowsKeyboardDurationUnlessMotionIsOff() {
        let on = PrototypeMotion(specMotion: nil, reduceMotion: false)
        XCTAssertEqual(PrototypeKeyboardLift.animationDuration(keyboardDuration: 0.25, motion: on), 0.25)
        XCTAssertNil(PrototypeKeyboardLift.animationDuration(keyboardDuration: nil, motion: on))
        XCTAssertNil(PrototypeKeyboardLift.animationDuration(keyboardDuration: 0, motion: on))
        XCTAssertNil(PrototypeKeyboardLift.animationDuration(
            keyboardDuration: 0.25, motion: PrototypeMotion(specMotion: "none", reduceMotion: false)
        ))
        XCTAssertNil(PrototypeKeyboardLift.animationDuration(
            keyboardDuration: 0.25, motion: PrototypeMotion(specMotion: nil, reduceMotion: true)
        ))
    }

    func testSheetFrameMovesUpWithTheLiftAndStaysInTheWindow() {
        let raised = PrototypeSheetFrame.rect(
            containerWidth: 400,
            containerHeight: 800,
            edge: "bottom",
            height: 200,
            lift: 300
        )
        XCTAssertEqual(raised, PrototypeRect(x: 0, y: 300, width: 400, height: 200))
        let capped = PrototypeSheetFrame.rect(
            containerWidth: 400,
            containerHeight: 800,
            edge: nil,
            height: 200,
            lift: 700
        )
        XCTAssertEqual(capped.y, 0)
        let top = PrototypeSheetFrame.rect(containerWidth: 400, containerHeight: 800, edge: "top", height: 200, lift: 300)
        XCTAssertEqual(top.y, 0, "a top sheet ignores the lift")
    }

    /// Where the sheet's bottom edge lands on screen: the full-window frame raised by the lift,
    /// plus any keyboard inset the host applied on its own (what `hostSafeAreaRegions` rules out).
    private func sheetBottomOnScreen(
        keyboard: PrototypeRect, windowOriginY: Double, windowHeight: Double, sheetHeight: Double,
        hostKeyboardInset: Double = 0
    )
        -> Double
    {
        let lift = PrototypeKeyboardLift.amount(
            placementType: "sheet", edge: "bottom", keyboardFrame: keyboard,
            windowOriginY: windowOriginY, windowHeight: windowHeight
        )
        let frame = PrototypeSheetFrame.rect(
            containerWidth: 402, containerHeight: windowHeight, edge: "bottom", height: sheetHeight,
            lift: lift + hostKeyboardInset
        )
        return windowOriginY + frame.y + frame.height
    }

    func testSheetBottomMeetsTheKeyboardTopOnTheIssueDevice() {
        // #11042: iPhone 17, iOS 26.5, 874 pt screen, keyboard top at 540, 300 pt sheet.
        let keyboard = PrototypeRect(x: 0, y: 540, width: 402, height: 334)
        XCTAssertEqual(
            sheetBottomOnScreen(keyboard: keyboard, windowOriginY: 0, windowHeight: 874, sheetHeight: 300), 540
        )
    }

    func testSheetBottomMeetsTheKeyboardTopInAnOffsetShorterWindow() {
        // A window that does not start at the screen's top and is shorter than the screen.
        let keyboard = PrototypeRect(x: 0, y: 540, width: 402, height: 334)
        for (originY, height) in [(20.0, 854.0), (44.0, 800.0), (100.0, 700.0)] {
            XCTAssertEqual(
                sheetBottomOnScreen(keyboard: keyboard, windowOriginY: originY, windowHeight: height, sheetHeight: 300),
                540,
                "window origin \(originY), height \(height)"
            )
        }
    }

    func testHostsApplyNoKeyboardInsetOnTopOfTheManualLift() {
        // The manual lift is the only keyboard mechanism: the hosting controllers keep neither the
        // keyboard nor the container region, so they add no inset (#11042's 527 pt over-lift).
        XCTAssertFalse(PrototypeKeyboardLift.hostSafeAreaRegions.contains(.keyboard))
        XCTAssertFalse(PrototypeKeyboardLift.hostSafeAreaRegions.contains(.container))
        let keyboard = PrototypeRect(x: 0, y: 540, width: 402, height: 334)
        let hostInset = PrototypeKeyboardLift.hostSafeAreaRegions.contains(.keyboard) ? 334.0 : 0
        XCTAssertEqual(
            sheetBottomOnScreen(
                keyboard: keyboard, windowOriginY: 0, windowHeight: 874, sheetHeight: 300, hostKeyboardInset: hostInset
            ),
            540
        )
        // Were the host to keep its keyboard safe area, the sheet would sit a keyboard height too high.
        XCTAssertLessThan(
            sheetBottomOnScreen(
                keyboard: keyboard, windowOriginY: 0, windowHeight: 874, sheetHeight: 300, hostKeyboardInset: 334
            ),
            540
        )
    }
}
