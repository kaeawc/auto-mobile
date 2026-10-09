@testable import AutoMobileOverlayAgentCore
import XCTest

final class OverlayCaptureHoldTests: XCTestCase {
    private var time: TimeInterval = 100

    private func makeHold() -> OverlayCaptureHold {
        OverlayCaptureHold(now: { self.time })
    }

    func testHidesUntilRestore() {
        var hold = makeHold()
        XCTAssertFalse(hold.isHiding)
        let ticket = hold.hide(deadlineMs: 1500)
        XCTAssertTrue(hold.isHiding)
        XCTAssertEqual(hold.restore(token: ticket.token), .init(released: true, shouldShow: true))
        XCTAssertFalse(hold.isHiding)
    }

    func testRestoreWhenNothingHiddenIsANoOp() {
        var hold = makeHold()
        XCTAssertEqual(hold.restore(token: nil), .init(released: false, shouldShow: false))
        XCTAssertEqual(hold.restore(token: 7), .init(released: false, shouldShow: false))
    }

    func testDeadlineAutoRestores() {
        var hold = makeHold()
        let ticket = hold.hide(deadlineMs: 1500)
        time += 1.499
        XCTAssertFalse(hold.expire(ticket))
        XCTAssertTrue(hold.isHiding)
        time += 0.001
        XCTAssertTrue(hold.expire(ticket))
        XCTAssertFalse(hold.isHiding)
    }

    func testExpiryAfterManualRestoreDoesNothing() {
        var hold = makeHold()
        let ticket = hold.hide(deadlineMs: 1500)
        XCTAssertTrue(hold.restore(token: ticket.token).released)
        time += 2
        XCTAssertFalse(hold.expire(ticket))
    }

    func testOverlappingHoldsShowOnlyWhenTheLastIsReleased() {
        var hold = makeHold()
        let a = hold.hide(deadlineMs: 1500)
        let b = hold.hide(deadlineMs: 1500)
        XCTAssertNotEqual(a.token, b.token)
        XCTAssertEqual(hold.restore(token: a.token), .init(released: true, shouldShow: false))
        XCTAssertTrue(hold.isHiding, "capture B is still running")
        XCTAssertEqual(hold.restore(token: b.token), .init(released: true, shouldShow: true))
        XCTAssertFalse(hold.isHiding)
    }

    func testEarlierExpiryDoesNotShowWhileALaterHoldIsLive() {
        var hold = makeHold()
        let first = hold.hide(deadlineMs: 1000)
        time += 0.5
        let second = hold.hide(deadlineMs: 1000)
        time += 0.5
        XCTAssertFalse(hold.expire(first), "the second hold is still live")
        XCTAssertTrue(hold.isHiding)
        time += 0.5
        XCTAssertTrue(hold.expire(second))
        XCTAssertFalse(hold.isHiding)
    }

    func testRestoreOfAnExpiredTokenReportsNotReleased() {
        var hold = makeHold()
        let a = hold.hide(deadlineMs: 1000)
        let b = hold.hide(deadlineMs: 5000)
        time += 1
        XCTAssertFalse(hold.expire(a))
        XCTAssertEqual(hold.restore(token: a.token), .init(released: false, shouldShow: false))
        XCTAssertTrue(hold.isHiding, "B's hold is untouched")
        XCTAssertTrue(hold.restore(token: b.token).shouldShow)
    }

    func testRestoreWithoutTokenReleasesEveryHold() {
        var hold = makeHold()
        _ = hold.hide(deadlineMs: 1000)
        _ = hold.hide(deadlineMs: 1000)
        XCTAssertEqual(hold.restore(token: nil), .init(released: true, shouldShow: true))
        XCTAssertFalse(hold.isHiding)
    }

    func testStaleExpiryAfterANewHideIsIgnored() {
        var hold = makeHold()
        let first = hold.hide(deadlineMs: 100)
        XCTAssertTrue(hold.restore(token: first.token).released)
        _ = hold.hide(deadlineMs: 5000)
        time += 1
        XCTAssertFalse(hold.expire(first))
        XCTAssertTrue(hold.isHiding)
    }

    func testDeadlineIsClamped() {
        XCTAssertEqual(OverlayCaptureHold.clampedDeadlineMs(nil), 1500)
        XCTAssertEqual(OverlayCaptureHold.clampedDeadlineMs("x"), 1500)
        XCTAssertEqual(OverlayCaptureHold.clampedDeadlineMs(0), 1)
        XCTAssertEqual(OverlayCaptureHold.clampedDeadlineMs(800), 800)
        XCTAssertEqual(OverlayCaptureHold.clampedDeadlineMs(60000), 15000)
    }

    func testAdvertisesCaptureCapabilities() {
        for name in ["hide_for_capture", "restore_after_capture", "screenshot_hide_overlay_v1"] {
            XCTAssertTrue(OverlayAgentProtocol.capabilities.contains(name), name)
        }
    }
}
