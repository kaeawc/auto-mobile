@testable import AutoMobilePrototypeAgentCore
import XCTest

/// A modal bottom sheet lays out inside its window's placement frame, not the whole screen.
final class PrototypeModalSheetFrameTests: XCTestCase {
    private func container(
        _ type: String, edge: String? = nil, height: Double? = nil, content: PrototypeRect? = nil,
        lift: Double = 0, keyboardTop: Double? = nil
    )
        -> PrototypeRect
    {
        PrototypeModalSheetFrame.container(
            placementType: type, edge: edge, height: height, contentFrame: content,
            windowWidth: 400, windowHeight: 800, lift: lift, keyboardTop: keyboardTop
        )
    }

    func testSheetPlacementIsItsOwnFrameAtTheEdge() {
        XCTAssertEqual(container("sheet", height: 300), PrototypeRect(x: 0, y: 500, width: 400, height: 300))
        XCTAssertEqual(
            container("sheet", edge: "top", height: 300), PrototypeRect(x: 0, y: 0, width: 400, height: 300)
        )
    }

    func testBottomSheetPlacementRisesWithTheKeyboardLift() {
        XCTAssertEqual(
            container("sheet", height: 300, lift: 250, keyboardTop: 550),
            PrototypeRect(x: 0, y: 250, width: 400, height: 300)
        )
    }

    func testFloatingUsesTheReportedContentFrame() {
        let content = PrototypeRect(x: 20, y: 100, width: 200, height: 300)
        XCTAssertEqual(container("floating", content: content), content)
        XCTAssertEqual(container("floating"), PrototypeRect(x: 0, y: 0, width: 400, height: 800))
    }

    func testFullscreenFillsTheWindowAndStopsAtTheKeyboard() {
        XCTAssertEqual(container("fullscreen"), PrototypeRect(x: 0, y: 0, width: 400, height: 800))
        XCTAssertEqual(
            container("fullscreen", keyboardTop: 500), PrototypeRect(x: 0, y: 0, width: 400, height: 500)
        )
        XCTAssertEqual(container("fullscreen", keyboardTop: 800), PrototypeRect(x: 0, y: 0, width: 400, height: 800))
    }

    func testTopSheetWindowStaysPutAboveTheKeyboard() {
        XCTAssertEqual(
            container("sheet", edge: "top", height: 300, keyboardTop: 200),
            PrototypeRect(x: 0, y: 0, width: 400, height: 200)
        )
    }
}
