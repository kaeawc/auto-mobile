@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class HuntTimer: PrototypeTimerHandle {
    let delay: Int
    let fire: () -> Void
    private(set) var cancelled = false
    init(delay: Int, fire: @escaping () -> Void) {
        self.delay = delay
        self.fire = fire
    }

    func cancel() { cancelled = true }
}

private final class HuntClock: PrototypeClock {
    private(set) var timers: [HuntTimer] = []
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = HuntTimer(delay: afterMilliseconds, fire: fire)
        timers.append(timer)
        return timer
    }
}

/// Hunt: Android's `LaunchedEffect(openWhen, durationMs)` keeps a snackbar's countdown running
/// while it stays open; its position among other open modals is not part of the key.
final class HuntSnackbarTimeoutTests: XCTestCase {
    private func spec() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"state":{"first":false,"second":true},
         "root":{"type":"box","children":[
           {"type":"snackbar","openWhen":{"key":"first","equals":true},"text":"A","durationMs":3000},
           {"type":"snackbar","openWhen":{"key":"second","equals":true},"text":"B","durationMs":3000}]}}
        """.utf8))
    }

    /// B is open and counting down; A (earlier in the tree) then opens, shifting B's ordinal.
    /// B's timer must keep running, not be cancelled and restarted from zero.
    func testAnotherSnackbarOpeningBeforeDoesNotRestartTheRunningCountdown() throws {
        let spec = try spec()
        let clock = HuntClock()
        let timeouts = SnackbarTimeouts(clock: clock) { _ in }
        timeouts.sync(openModals: spec.root.openModals(state: ["first": .bool(false), "second": .bool(true)], pages: [:]))
        let bTimer = try XCTUnwrap(clock.timers.first)
        timeouts.sync(openModals: spec.root.openModals(state: ["first": .bool(true), "second": .bool(true)], pages: [:]))
        XCTAssertFalse(bTimer.cancelled, "B's countdown was cancelled when A opened ahead of it")
        XCTAssertEqual(clock.timers.count, 2, "only A should have started a new timer")
    }
}
