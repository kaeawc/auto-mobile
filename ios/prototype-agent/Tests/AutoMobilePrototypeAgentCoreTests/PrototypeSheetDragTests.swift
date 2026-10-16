@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSheetDragTests: XCTestCase {
    func testHeightsRetainAuthorOrderAndClampPoints() {
        XCTAssertEqual(
            prototypeSheetHeights(detents: [.full, .points(1200), .half, .points(200)], containerHeight: 800),
            [800, 800, 400, 200]
        )
        XCTAssertEqual(prototypeSheetHeights(detents: [], containerHeight: 800), [])
    }

    func testUpAndDownDragsSnapByPhysicalHeight() {
        XCTAssertEqual(
            settlePrototypeSheet(heights: [800, 200, 400], current: 400, drag: -350, dismissOnSwipe: true),
            800
        )
        XCTAssertEqual(
            settlePrototypeSheet(heights: [800, 200, 400], current: 800, drag: 550, dismissOnSwipe: true),
            200
        )
        XCTAssertEqual(settlePrototypeSheet(heights: [400, 800], current: 400, drag: -200, dismissOnSwipe: true), 400)
        XCTAssertEqual(settlePrototypeSheet(heights: [800, 400], current: 400, drag: -200, dismissOnSwipe: true), 800)
    }

    func testDismissalUsesStrictHalfOfSmallestDetent() {
        XCTAssertNil(settlePrototypeSheet(heights: [800, 200, 400], current: 400, drag: 301, dismissOnSwipe: true))
        XCTAssertEqual(
            settlePrototypeSheet(heights: [800, 200, 400], current: 400, drag: 300, dismissOnSwipe: true),
            200
        )
    }

    func testDisablingSwipeAlwaysSnapsEvenBelowZero() {
        XCTAssertEqual(settlePrototypeSheet(heights: [400, 200], current: 400, drag: 1000, dismissOnSwipe: false), 200)
    }

    func testSingleAndEmptyDetents() {
        XCTAssertEqual(settlePrototypeSheet(heights: [400], current: 400, drag: -800, dismissOnSwipe: true), 400)
        XCTAssertNil(settlePrototypeSheet(heights: [400], current: 400, drag: 201, dismissOnSwipe: true))
        XCTAssertEqual(settlePrototypeSheet(heights: [], current: 300, drag: 1000, dismissOnSwipe: true), 300)
    }

    func testDismissOnSwipeDecodesWithoutChangingTheWireDefault() throws {
        func node(_ field: String) throws -> PrototypeNode {
            try JSONDecoder().decode(PrototypeNode.self, from: Data("{\"type\":\"bottomSheet\"\(field)}".utf8))
        }
        XCTAssertNil(try node("").dismissOnSwipe)
        XCTAssertTrue(try node("").dismissOnSwipe ?? true)
        XCTAssertEqual(try node(",\"dismissOnSwipe\":false").dismissOnSwipe, false)
        XCTAssertEqual(try node(",\"dismissOnSwipe\":true").dismissOnSwipe, true)
    }

    func testDismissalClosesStateInsteadOfDismissingThePrototype() throws {
        for equals in [true, false] {
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
            {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"open":\(equals)},
             "root":{"type":"bottomSheet","openWhen":{"key":"open","equals":\(equals)}}}
            """.utf8))
            var session = PrototypeSession()
            session.show(spec)
            let events = session.closeModal(spec.root)
            XCTAssertEqual(session.state["open"], .bool(!equals))
            XCTAssertEqual(events.map(\.name), ["change"])
            XCTAssertTrue(session.isShown)
        }
    }
}
