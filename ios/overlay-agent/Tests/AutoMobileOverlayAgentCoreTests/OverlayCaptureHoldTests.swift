@testable import AutoMobileOverlayAgentCore
import XCTest

final class OverlayCaptureHoldTests: XCTestCase {
    private var time: TimeInterval = 100

    private func makeHold(tokenSeed: Int = 0) -> OverlayCaptureHold {
        OverlayCaptureHold(now: { self.time }, tokenSeed: tokenSeed)
    }

    func testTokensFollowTheInjectedSeed() {
        var hold = makeHold(tokenSeed: 41)
        XCTAssertEqual(hold.hide(deadlineMs: 1500).token, 42)
        XCTAssertEqual(hold.hide(deadlineMs: 1500).token, 43)
    }

    func testAStaleTokenFromAPreviousAgentProcessCannotReleaseALiveHold() {
        // The host captured with the old agent and kept its token across an agent relaunch.
        var previousProcess = makeHold(tokenSeed: 0)
        let staleToken = previousProcess.hide(deadlineMs: 1500).token
        var relaunched = makeHold(tokenSeed: 9_000_000)
        let live = relaunched.hide(deadlineMs: 1500)
        XCTAssertNotEqual(live.token, staleToken)
        XCTAssertEqual(relaunched.restore(token: staleToken), .init(released: false, shouldShow: false))
        XCTAssertTrue(relaunched.isHiding, "the live capture's hold survives the stale restore")
        XCTAssertEqual(relaunched.restore(token: live.token), .init(released: true, shouldShow: true))
    }

    func testRandomSeedsDifferPerProcessAndStayExactInTheJavaScriptHost() {
        var generator = SplitMix64(state: 7)
        let seeds = (0 ..< 64).map { _ in OverlayCaptureHold.randomTokenSeed(using: &generator) }
        XCTAssertEqual(Set(seeds).count, seeds.count)
        let maxSafeJavaScriptInteger = (1 << 53) - 1
        for seed in seeds {
            XCTAssertGreaterThanOrEqual(seed, 0)
            XCTAssertLessThan(seed, OverlayCaptureHold.maxTokenSeed)
            XCTAssertLessThan(seed + OverlayCaptureHold.maxTokenSeed, maxSafeJavaScriptInteger)
        }
        XCTAssertLessThan(OverlayCaptureHold.randomTokenSeed(), OverlayCaptureHold.maxTokenSeed)
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
        let holdA = hold.hide(deadlineMs: 1500)
        let holdB = hold.hide(deadlineMs: 1500)
        XCTAssertNotEqual(holdA.token, holdB.token)
        XCTAssertEqual(hold.restore(token: holdA.token), .init(released: true, shouldShow: false))
        XCTAssertTrue(hold.isHiding, "capture B is still running")
        XCTAssertEqual(hold.restore(token: holdB.token), .init(released: true, shouldShow: true))
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
        let holdA = hold.hide(deadlineMs: 1000)
        let holdB = hold.hide(deadlineMs: 5000)
        time += 1
        XCTAssertFalse(hold.expire(holdA))
        XCTAssertEqual(hold.restore(token: holdA.token), .init(released: false, shouldShow: false))
        XCTAssertTrue(hold.isHiding, "B's hold is untouched")
        XCTAssertTrue(hold.restore(token: holdB.token).shouldShow)
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

/// Deterministic generator for the seed-range test.
private struct SplitMix64: RandomNumberGenerator {
    var state: UInt64

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
        value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
        return value ^ (value >> 31)
    }
}
