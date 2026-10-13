@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeHitRectsTests: XCTestCase {
    private let fullscreen = CGRect(x: 0, y: 0, width: 400, height: 800)
    private let sheet = CGRect(x: 0, y: 600, width: 400, height: 200)
    private let floating = CGRect(x: 200, y: 300, width: 100, height: 100)

    func testPlacementSwapKeepsIncomingRectAfterOutgoingWithdrawal() {
        var rects = PrototypeHitRects()
        let outgoing = PrototypeHitRectOwner()
        let incoming = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "content", owner: outgoing)
        rects.report(sheet, key: "content", owner: incoming)
        rects.withdraw(key: "content", owner: outgoing)

        assertSheet(rects)
    }

    func testPlacementSwapKeepsIncomingRectWhenOutgoingWithdrawsFirst() {
        var rects = PrototypeHitRects()
        let outgoing = PrototypeHitRectOwner()
        let incoming = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "content", owner: outgoing)
        rects.withdraw(key: "content", owner: outgoing)
        rects.report(sheet, key: "content", owner: incoming)

        assertSheet(rects)
    }

    func testLateOutgoingReportCannotTakeOverIncomingRect() {
        var rects = PrototypeHitRects()
        let outgoing = PrototypeHitRectOwner()
        let incoming = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "content", owner: outgoing)
        rects.report(sheet, key: "content", owner: incoming)
        // An outgoing geometry callback may arrive after the replacement's callback (#12207).
        rects.report(fullscreen, key: "content", owner: outgoing)
        rects.withdraw(key: "content", owner: outgoing)

        assertSheet(rects)
    }

    func testBothOwnersHoldContentUntilTheirOwnWithdrawal() {
        var rects = PrototypeHitRects()
        let outgoing = PrototypeHitRectOwner()
        let incoming = PrototypeHitRectOwner()
        rects.report(floating, key: "content", owner: outgoing)
        rects.report(sheet, key: "content", owner: incoming)
        let outgoingPoint = CGPoint(x: 250, y: 350)
        let incomingPoint = CGPoint(x: 20, y: 700)
        XCTAssertTrue(rects.contains(outgoingPoint))
        XCTAssertEqual(rects.layer(at: outgoingPoint), .page)
        XCTAssertTrue(rects.contains(incomingPoint))
        XCTAssertEqual(rects.layer(at: incomingPoint), .page)

        rects.withdraw(key: "content", owner: outgoing)
        XCTAssertFalse(rects.contains(outgoingPoint))
        XCTAssertNil(rects.layer(at: outgoingPoint))
        assertSheet(rects)
    }

    func testTopLayerWinsOverPageAndOutsidePassesThrough() {
        for key in ["modal.0", "dismiss"] {
            var rects = PrototypeHitRects()
            rects.report(fullscreen, key: "content", owner: PrototypeHitRectOwner())
            rects.report(floating, key: key, owner: PrototypeHitRectOwner())
            let overlap = CGPoint(x: 250, y: 350)
            XCTAssertTrue(rects.contains(overlap))
            XCTAssertEqual(rects.layer(at: overlap), .top)
            XCTAssertEqual(rects.layer(at: CGPoint(x: 20, y: 20)), .page)
            let outside = CGPoint(x: 450, y: 900)
            XCTAssertFalse(rects.contains(outside))
            XCTAssertNil(rects.layer(at: outside))
        }
    }

    func testOwnerCanReportAgainAfterBeingDisabled() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.report(nil, key: "content", owner: owner)
        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 700)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 20, y: 700)))

        rects.report(sheet, key: "content", owner: owner)
        assertSheet(rects)
    }

    func testRapidReplacementsIgnoreEachLateOutgoingWithdrawal() {
        var rects = PrototypeHitRects()
        let owners = (0 ..< 4).map { _ in PrototypeHitRectOwner() }
        let frames = [fullscreen, sheet, floating, fullscreen]
        rects.report(frames[0], key: "content", owner: owners[0])
        for index in 1 ..< owners.count {
            rects.report(frames[index], key: "content", owner: owners[index])
            rects.withdraw(key: "content", owner: owners[index - 1])
            for point in [CGPoint(x: 20, y: 20), CGPoint(x: 20, y: 700), CGPoint(x: 250, y: 350)] {
                let contains = frames[index].contains(point)
                XCTAssertEqual(rects.contains(point), contains)
                XCTAssertEqual(rects.layer(at: point), contains ? .page : nil)
            }
        }
    }

    func testRapidReplacementsIgnoreTwoStaleWithdrawalsArrivingTogether() {
        var rects = PrototypeHitRects()
        let owners = (0 ..< 4).map { _ in PrototypeHitRectOwner() }
        rects.report(fullscreen, key: "content", owner: owners[0])
        rects.report(sheet, key: "content", owner: owners[1])
        rects.report(floating, key: "content", owner: owners[2])
        rects.report(fullscreen, key: "content", owner: owners[3])
        rects.withdraw(key: "content", owner: owners[2])
        rects.withdraw(key: "content", owner: owners[0])
        rects.withdraw(key: "content", owner: owners[1])

        XCTAssertTrue(rects.contains(CGPoint(x: 20, y: 20)))
        XCTAssertTrue(rects.contains(CGPoint(x: 20, y: 700)))
        XCTAssertEqual(rects.layer(at: CGPoint(x: 20, y: 20)), .page)
    }

    func testDismissChipSurvivesBarBranchWithdrawalAndBelongsToTopLayer() {
        var rects = PrototypeHitRects()
        let bar = PrototypeHitRectOwner()
        let chip = PrototypeHitRectOwner()
        let chipRect = CGRect(x: 350, y: 40, width: 44, height: 44)
        rects.report(CGRect(x: 350, y: 60, width: 44, height: 44), key: "dismiss", owner: bar)
        rects.report(chipRect, key: "dismiss", owner: chip)
        rects.withdraw(key: "dismiss", owner: bar)

        let point = CGPoint(x: 370, y: 50)
        XCTAssertTrue(rects.contains(point))
        XCTAssertEqual(rects.layer(at: point), .top)
        XCTAssertFalse(rects.contains(CGPoint(x: 370, y: 100)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 370, y: 100)))
    }

    func testModalReplacementIgnoresOutgoingBranchWithdrawal() {
        var rects = PrototypeHitRects()
        let dialog = PrototypeHitRectOwner()
        let snackbar = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "modal.0", owner: dialog)
        rects.report(sheet, key: "modal.0", owner: snackbar)
        rects.withdraw(key: "modal.0", owner: dialog)

        XCTAssertTrue(rects.contains(CGPoint(x: 20, y: 700)))
        XCTAssertEqual(rects.layer(at: CGPoint(x: 20, y: 700)), .top)
        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 20)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 20, y: 20)))
    }

    func testOwnerWithdrawalClearsItsOwnKey() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.withdraw(key: "content", owner: owner)

        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 700)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 20, y: 700)))
    }

    func testNilReportFromOwnerClearsItsOwnKey() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.report(nil, key: "content", owner: owner)

        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 700)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 20, y: 700)))
    }

    func testNonOwnerNilReportAndWithdrawalLeaveRectUntouched() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        let stale = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.report(nil, key: "content", owner: stale)
        assertSheet(rects)
        rects.withdraw(key: "content", owner: stale)
        assertSheet(rects)
    }

    func testLaterReportFromSameOwnerReplacesRect() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "content", owner: owner)
        rects.report(sheet, key: "content", owner: owner)

        assertSheet(rects)
    }

    func testRemoveAllClearsAllKeysAndStaleWithdrawalCannotClearNewReport() {
        var rects = PrototypeHitRects()
        let stale = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "content", owner: stale)
        rects.report(floating, key: "dismiss", owner: PrototypeHitRectOwner())
        rects.removeAll()
        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 20)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 20, y: 20)))
        XCTAssertFalse(rects.contains(CGPoint(x: 250, y: 350)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 250, y: 350)))
        rects.report(sheet, key: "content", owner: PrototypeHitRectOwner())
        rects.withdraw(key: "content", owner: stale)

        assertSheet(rects)
    }

    func testChangingKeyWithdrawsOldKeyWithoutClearingAnotherReporter() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        let replacement = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "anchor.old", owner: owner)
        rects.report(sheet, key: "anchor.old", owner: replacement)
        rects.withdraw(key: "anchor.old", owner: owner)
        rects.report(floating, key: "anchor.new", owner: owner)

        XCTAssertTrue(rects.contains(CGPoint(x: 20, y: 700)))
        XCTAssertEqual(rects.layer(at: CGPoint(x: 20, y: 700)), .page)
        XCTAssertTrue(rects.contains(CGPoint(x: 250, y: 350)))
        XCTAssertEqual(rects.layer(at: CGPoint(x: 250, y: 350)), .page)
        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 20)))
        rects.withdraw(key: "anchor.new", owner: owner)
        assertSheet(rects)
        XCTAssertFalse(rects.contains(CGPoint(x: 250, y: 350)))
        XCTAssertNil(rects.layer(at: CGPoint(x: 250, y: 350)))
    }

    func testEachOwnerHasUniqueIdentity() {
        XCTAssertNotEqual(PrototypeHitRectOwner(), PrototypeHitRectOwner())
    }

    private func assertSheet(_ rects: PrototypeHitRects, file: StaticString = #filePath, line: UInt = #line) {
        let inside = CGPoint(x: 20, y: 700)
        let outside = CGPoint(x: 20, y: 300)
        XCTAssertTrue(rects.contains(inside), file: file, line: line)
        XCTAssertEqual(rects.layer(at: inside), .page, file: file, line: line)
        XCTAssertFalse(rects.contains(outside), file: file, line: line)
        XCTAssertNil(rects.layer(at: outside), file: file, line: line)
    }
}
