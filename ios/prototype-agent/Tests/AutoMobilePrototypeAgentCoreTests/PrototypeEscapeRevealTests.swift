@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The existing fake PrototypeClock/handle pattern with a virtual deadline for boundary assertions.
private final class EscapeTimer: PrototypeTimerHandle {
    let deadline: Int
    let fire: () -> Void
    private(set) var cancelled = false

    init(deadline: Int, fire: @escaping () -> Void) {
        self.deadline = deadline
        self.fire = fire
    }

    func cancel() { cancelled = true }
}

private final class EscapeClock: PrototypeClock {
    private var now = 0
    private(set) var timers: [EscapeTimer] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = EscapeTimer(deadline: now + afterMilliseconds, fire: fire)
        timers.append(timer)
        return timer
    }

    func advance(milliseconds: Int) {
        now += milliseconds
        for timer in timers where !timer.cancelled && timer.deadline <= now {
            timer.cancel()
            timer.fire()
        }
    }
}

final class PrototypeEscapeRevealTests: XCTestCase {
    func testRevealLastsExactlyFiveSecondsAndNotifiesOnlyChanges() {
        let clock = EscapeClock()
        var changes: [Bool] = []
        let reveal = PrototypeEscapeReveal(clock: clock) { changes.append($0) }
        reveal.sync(hasEscape: true, shown: true)
        XCTAssertEqual(PrototypeEscapeReveal.visibleMilliseconds, 5000)
        XCTAssertEqual(PrototypeEscapeReveal.holdSeconds, 1.0)
        XCTAssertFalse(reveal.isVisible)
        reveal.hide()
        XCTAssertEqual(changes, [])
        reveal.reveal()
        XCTAssertTrue(reveal.isVisible)
        XCTAssertEqual(changes, [true])
        clock.advance(milliseconds: 4999)
        XCTAssertTrue(reveal.isVisible)
        clock.advance(milliseconds: 1)
        XCTAssertFalse(reveal.isVisible)
        XCTAssertEqual(changes, [true, false])
        clock.advance(milliseconds: 5000)
        reveal.hide()
        XCTAssertEqual(changes, [true, false])
    }

    func testSecondRevealRestartsTheDeadlineWithoutAnotherVisibleCallback() {
        let clock = EscapeClock()
        var changes: [Bool] = []
        let reveal = PrototypeEscapeReveal(clock: clock) { changes.append($0) }
        reveal.sync(hasEscape: true, shown: true)
        reveal.reveal()
        clock.advance(milliseconds: 3000)
        let first = clock.timers[0]
        reveal.reveal()
        XCTAssertTrue(first.cancelled)
        first.fire() // A cancelled callback already queued must not hide the restarted reveal.
        XCTAssertTrue(reveal.isVisible)
        XCTAssertEqual(changes, [true])
        clock.advance(milliseconds: 2000)
        XCTAssertTrue(reveal.isVisible)
        clock.advance(milliseconds: 2999)
        XCTAssertTrue(reveal.isVisible)
        clock.advance(milliseconds: 1)
        XCTAssertFalse(reveal.isVisible)
        XCTAssertEqual(changes, [true, false])
    }

    func testHideCancelsAndRejectsLateCallbacks() {
        let clock = EscapeClock()
        var changes: [Bool] = []
        let reveal = PrototypeEscapeReveal(clock: clock) { changes.append($0) }
        reveal.sync(hasEscape: true, shown: true)
        reveal.reveal()
        reveal.hide()
        XCTAssertTrue(clock.timers[0].cancelled)
        XCTAssertFalse(reveal.isVisible)
        clock.timers[0].fire()
        clock.advance(milliseconds: 5000)
        reveal.hide()
        XCTAssertEqual(changes, [true, false])
        reveal.reveal()
        clock.timers[0].fire()
        XCTAssertTrue(reveal.isVisible)
        clock.advance(milliseconds: 5000)
        XCTAssertEqual(changes, [true, false, true, false])
    }

    func testDismissalHidesAndASubsequentShowStartsHidden() {
        let clock = EscapeClock()
        let reveal = PrototypeEscapeReveal(clock: clock) { _ in }
        reveal.sync(hasEscape: true, shown: true)
        reveal.reveal()
        reveal.sync(hasEscape: true, shown: false)
        XCTAssertFalse(reveal.isVisible)
        XCTAssertTrue(clock.timers[0].cancelled)
        reveal.reveal()
        XCTAssertFalse(reveal.isVisible)
        reveal.sync(hasEscape: true, shown: true)
        XCTAssertFalse(reveal.isVisible)
        clock.timers[0].fire()
        XCTAssertFalse(reveal.isVisible)
    }

    func testReplacingNoneWithBarHidesAndCannotReveal() {
        let clock = EscapeClock()
        let reveal = PrototypeEscapeReveal(clock: clock) { _ in }
        reveal.sync(hasEscape: true, shown: true)
        reveal.reveal()
        reveal.sync(hasEscape: false, shown: true)
        XCTAssertFalse(reveal.isVisible)
        XCTAssertTrue(clock.timers[0].cancelled)
        reveal.reveal()
        XCTAssertFalse(reveal.isVisible)
        XCTAssertEqual(clock.timers.count, 1)
    }

    func testReplacingNoneWithNoneKeepsTheRemainingDeadline() {
        let clock = EscapeClock()
        let reveal = PrototypeEscapeReveal(clock: clock) { _ in }
        reveal.sync(hasEscape: true, shown: true)
        reveal.reveal()
        clock.advance(milliseconds: 3000)
        reveal.sync(hasEscape: true, shown: true)
        XCTAssertTrue(reveal.isVisible)
        XCTAssertEqual(clock.timers.count, 1)
        XCTAssertEqual(clock.timers[0].deadline, 5000)
        XCTAssertFalse(clock.timers[0].cancelled)
        clock.advance(milliseconds: 1999)
        XCTAssertTrue(reveal.isVisible)
        clock.advance(milliseconds: 1)
        XCTAssertFalse(reveal.isVisible)
    }

    func testRevealWithoutAnEscapeDoesNothing() {
        let clock = EscapeClock()
        let reveal = PrototypeEscapeReveal(clock: clock) { _ in XCTFail("No visibility change expected") }
        reveal.reveal()
        reveal.sync(hasEscape: false, shown: true)
        reveal.reveal()
        XCTAssertFalse(reveal.isVisible)
        XCTAssertTrue(clock.timers.isEmpty)
    }
}
