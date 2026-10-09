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
        _ = hold.hide(deadlineMs: 1500)
        XCTAssertTrue(hold.isHiding)
        XCTAssertTrue(hold.restore())
        XCTAssertFalse(hold.isHiding)
    }

    func testRestoreWhenNothingHiddenIsANoOp() {
        var hold = makeHold()
        XCTAssertFalse(hold.restore())
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
        XCTAssertTrue(hold.restore())
        time += 2
        XCTAssertFalse(hold.expire(ticket))
    }

    func testSecondHideInvalidatesTheFirstTimer() {
        var hold = makeHold()
        let first = hold.hide(deadlineMs: 1000)
        time += 0.5
        let second = hold.hide(deadlineMs: 1000)
        time += 0.6
        XCTAssertFalse(hold.expire(first), "the first hold's deadline must not cut the second short")
        XCTAssertTrue(hold.isHiding)
        time += 0.4
        XCTAssertTrue(hold.expire(second))
    }

    func testStaleExpiryAfterANewHideIsIgnored() {
        var hold = makeHold()
        let first = hold.hide(deadlineMs: 100)
        XCTAssertTrue(hold.restore())
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
        XCTAssertEqual(OverlayCaptureHold.clampedDeadlineMs(60000), 5000)
    }

    func testAdvertisesCaptureCapabilities() {
        for name in ["hide_for_capture", "restore_after_capture", "screenshot_hide_overlay_v1"] {
            XCTAssertTrue(OverlayAgentProtocol.capabilities.contains(name), name)
        }
    }
}
