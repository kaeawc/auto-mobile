@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePlacementTests: XCTestCase {
    private let window = CGRect(x: 0, y: 0, width: 400, height: 600)
    private let bubble = CGSize(width: 120, height: 60)

    func testBelowFitsAndCaretPointsToCenter() {
        let result = place(CGRect(x: 100, y: 100, width: 40, height: 40))
        XCTAssertEqual(result.caret, .top)
        XCTAssertEqual(result.origin, CGPoint(x: 60, y: 148))
        XCTAssertEqual(result.caretOffset, 60)
    }

    func testFlipsAbove() {
        let result = place(CGRect(x: 100, y: 540, width: 40, height: 40))
        XCTAssertEqual(result.caret, .bottom)
        XCTAssertEqual(result.origin.y, 472)
    }

    func testHorizontalFlipAndRTL() {
        let target = CGRect(x: 350, y: 100, width: 30, height: 40)
        XCTAssertEqual(place(target, caret: .start).caret, .end)
        XCTAssertEqual(place(target, caret: .end, rtl: true).caret, .start)
        let left = CGRect(x: 20, y: 100, width: 30, height: 40)
        XCTAssertEqual(place(left, caret: .end).caret, .start)
        XCTAssertEqual(place(left, caret: .start, rtl: true).caret, .end)
    }

    func testExplicitBottomFlipsBelowAndRTLChangesPhysicalSide() {
        XCTAssertEqual(place(CGRect(x: 100, y: 10, width: 40, height: 20), caret: .bottom).caret, .top)
        let target = CGRect(x: 180, y: 100, width: 40, height: 40)
        let ltr = place(target, caret: .start)
        let rtl = place(target, caret: .start, rtl: true)
        XCTAssertEqual(ltr.origin.x, 228)
        XCTAssertEqual(rtl.origin.x, 52)
        XCTAssertEqual(ltr.caretOffset, 30)
        XCTAssertEqual(rtl.caretOffset, 30)
    }

    func testMenuNeitherFitsKeepsExistingClamp() {
        XCTAssertEqual(
            PrototypeMenus.origin(
                anchor: CGRect(x: 100, y: 280, width: 40, height: 40),
                surface: CGSize(width: 120, height: 400),
                window: window.size
            ),
            CGPoint(x: 20, y: 200)
        )
    }

    func testClampAndCaretCornerLimit() {
        let result = place(CGRect(x: 0, y: 100, width: 2, height: 10))
        XCTAssertEqual(result.origin.x, 8)
        XCTAssertEqual(result.caretOffset, 12)
    }

    func testNeitherFitsChoosesMoreRoom() {
        let result = PrototypePlacement.place(
            target: CGRect(x: 100, y: 350, width: 30, height: 40),
            bubble: CGSize(width: 120, height: 400), window: window
        )
        XCTAssertEqual(result.caret, .bottom)
        XCTAssertEqual(result.origin.y, 8)
    }

    func testMenuFlipAndUnchangedAlignment() {
        XCTAssertEqual(PrototypeMenus.origin(
            anchor: CGRect(x: 100, y: 100, width: 40, height: 40),
            surface: bubble,
            window: window.size
        ), CGPoint(x: 20, y: 140))
        XCTAssertEqual(PrototypeMenus.origin(
            anchor: CGRect(x: 100, y: 560, width: 40, height: 30),
            surface: bubble,
            window: window.size
        ), CGPoint(x: 20, y: 500))
    }

    private func place(_ target: CGRect, caret: PrototypeCaret = .auto, rtl: Bool = false) -> PrototypePlacement {
        PrototypePlacement.place(
            target: target,
            bubble: bubble,
            window: window,
            rightToLeft: rtl,
            caret: caret
        )
    }
}
