@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class WatchdogTimer: PrototypeTimerHandle {
    let delay: Int
    let fire: () -> Void
    private(set) var cancelled = false
    init(delay: Int, fire: @escaping () -> Void) {
        self.delay = delay
        self.fire = fire
    }

    func cancel() { cancelled = true }
}

private final class WatchdogClock: PrototypeClock {
    private(set) var timers: [WatchdogTimer] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = WatchdogTimer(delay: afterMilliseconds, fire: fire)
        timers.append(timer)
        return timer
    }
}

final class PrototypeRenderWatchdogTests: XCTestCase {
    func testBudgetMatchesAndroidTenSeconds() {
        XCTAssertEqual(PrototypeRenderWatchdog.budgetMilliseconds, 10000)
    }

    func testTimesOutOnceWhenFirstContentNeverArrives() throws {
        let clock = WatchdogClock()
        let watchdog = PrototypeRenderWatchdog(clock: clock)
        var timeouts = 0
        watchdog.start { timeouts += 1 }
        XCTAssertTrue(watchdog.isArmed)
        let timer = try XCTUnwrap(clock.timers.first)
        XCTAssertEqual(timer.delay, 10000)
        timer.fire()
        timer.fire()
        XCTAssertEqual(timeouts, 1)
        XCTAssertFalse(watchdog.isArmed)
    }

    func testFirstContentCancelsTheDeadline() throws {
        let clock = WatchdogClock()
        let watchdog = PrototypeRenderWatchdog(clock: clock)
        var timeouts = 0
        watchdog.start { timeouts += 1 }
        let timer = try XCTUnwrap(clock.timers.first)
        watchdog.cancel()
        XCTAssertTrue(timer.cancelled)
        XCTAssertFalse(watchdog.isArmed)
        timer.fire() // a timer already queued when readiness arrived
        XCTAssertEqual(timeouts, 0)
    }

    func testRestartSupersedesTheEarlierDeadline() throws {
        let clock = WatchdogClock()
        let watchdog = PrototypeRenderWatchdog(clock: clock)
        var first = 0
        var second = 0
        watchdog.start { first += 1 }
        watchdog.start { second += 1 }
        XCTAssertEqual(clock.timers.count, 2)
        XCTAssertTrue(clock.timers[0].cancelled)
        clock.timers[0].fire()
        XCTAssertEqual(first, 0)
        clock.timers[1].fire()
        XCTAssertEqual(second, 1)
    }

    func testCancelWithoutStartIsHarmless() {
        let watchdog = PrototypeRenderWatchdog(clock: WatchdogClock())
        watchdog.cancel()
        XCTAssertFalse(watchdog.isArmed)
    }
}
