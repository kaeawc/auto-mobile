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
}
