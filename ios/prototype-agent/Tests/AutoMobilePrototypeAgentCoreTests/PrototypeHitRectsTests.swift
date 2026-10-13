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

    func testRapidReplacementsIgnoreEachLateOutgoingWithdrawal() {
        var rects = PrototypeHitRects()
        let owners = (0..<4).map { _ in PrototypeHitRectOwner() }
        let frames = [fullscreen, sheet, floating, fullscreen]
        rects.report(frames[0], key: "content", owner: owners[0])
        for index in 1..<owners.count {
            rects.report(frames[index], key: "content", owner: owners[index])
            rects.withdraw(key: "content", owner: owners[index - 1])
            XCTAssertEqual(rects.rects, ["content": frames[index]])
            XCTAssertTrue(rects.contains(CGPoint(x: frames[index].midX, y: frames[index].midY)))
        }
    }

    func testRapidReplacementsIgnoreTwoStaleWithdrawalsArrivingTogether() {
        var rects = PrototypeHitRects()
        let owners = (0..<4).map { _ in PrototypeHitRectOwner() }
        rects.report(fullscreen, key: "content", owner: owners[0])
        rects.report(sheet, key: "content", owner: owners[1])
        rects.report(floating, key: "content", owner: owners[2])
        rects.report(fullscreen, key: "content", owner: owners[3])
        rects.withdraw(key: "content", owner: owners[2])
        rects.withdraw(key: "content", owner: owners[0])
        rects.withdraw(key: "content", owner: owners[1])

        XCTAssertEqual(rects.rects, ["content": fullscreen])
        XCTAssertTrue(rects.contains(CGPoint(x: 20, y: 20)))
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
        XCTAssertEqual(rects.rects, ["dismiss": chipRect])
        XCTAssertTrue(rects.contains(point))
        XCTAssertEqual(PrototypeHostLayer.owner(of: point, hitRects: rects.rects), .top)
    }

    func testModalReplacementIgnoresOutgoingBranchWithdrawal() {
        var rects = PrototypeHitRects()
        let dialog = PrototypeHitRectOwner()
        let snackbar = PrototypeHitRectOwner()
        rects.report(fullscreen, key: "modal.0", owner: dialog)
        rects.report(sheet, key: "modal.0", owner: snackbar)
        rects.withdraw(key: "modal.0", owner: dialog)

        XCTAssertEqual(rects.rects, ["modal.0": sheet])
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 20, y: 700), hitRects: rects.rects), .top)
    }

    func testOwnerWithdrawalClearsItsOwnKey() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.withdraw(key: "content", owner: owner)

        XCTAssertTrue(rects.rects.isEmpty)
        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 700)))
    }

    func testNilReportFromOwnerClearsItsOwnKey() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.report(nil, key: "content", owner: owner)

        XCTAssertTrue(rects.rects.isEmpty)
    }

    func testNonOwnerNilReportAndWithdrawalLeaveRectUntouched() {
        var rects = PrototypeHitRects()
        let owner = PrototypeHitRectOwner()
        let stale = PrototypeHitRectOwner()
        rects.report(sheet, key: "content", owner: owner)
        rects.report(nil, key: "content", owner: stale)
        XCTAssertEqual(rects.rects, ["content": sheet])
        rects.withdraw(key: "content", owner: stale)
        XCTAssertEqual(rects.rects, ["content": sheet])
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
        XCTAssertTrue(rects.rects.isEmpty)
        XCTAssertFalse(rects.contains(CGPoint(x: 20, y: 20)))
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

        XCTAssertEqual(rects.rects, ["anchor.old": sheet, "anchor.new": floating])
        rects.withdraw(key: "anchor.new", owner: owner)
        XCTAssertEqual(rects.rects, ["anchor.old": sheet])
    }

    func testEachOwnerHasUniqueIdentity() {
        XCTAssertNotEqual(PrototypeHitRectOwner(), PrototypeHitRectOwner())
    }

    private func assertSheet(_ rects: PrototypeHitRects, file: StaticString = #filePath, line: UInt = #line) {
        let inside = CGPoint(x: 20, y: 700)
        let outside = CGPoint(x: 20, y: 300)
        XCTAssertEqual(rects.rects, ["content": sheet], file: file, line: line)
        XCTAssertTrue(rects.contains(inside), file: file, line: line)
        XCTAssertEqual(PrototypeHostLayer.owner(of: inside, hitRects: rects.rects), .page, file: file, line: line)
        XCTAssertFalse(rects.contains(outside), file: file, line: line)
        XCTAssertNil(PrototypeHostLayer.owner(of: outside, hitRects: rects.rects), file: file, line: line)
    }
}
