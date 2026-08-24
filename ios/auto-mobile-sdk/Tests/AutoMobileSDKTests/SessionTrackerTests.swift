import XCTest
@testable import AutoMobileSDK

final class SessionTrackerTests: XCTestCase {

    private func makeTracker(
        timeoutMs: Int = 30_000,
        uuidSequence: [String] = ["session-1", "session-2", "session-3"]
    ) -> (SessionTracker, FakeTimer) {
        var index = 0
        let fakeTimer = FakeTimer()
        let tracker = SessionTracker(
            timeoutMs: timeoutMs,
            uuidProvider: {
                let id = uuidSequence[min(index, uuidSequence.count - 1)]
                index += 1
                return id
            },
            timerFactory: { fakeTimer }
        )
        return (tracker, fakeTimer)
    }

    // MARK: - New session on first foreground

    func testNewSessionOnFirstForeground() {
        let (tracker, _) = makeTracker()
        XCTAssertNil(tracker.currentSessionId())

        tracker.onForeground()
        XCTAssertEqual(tracker.currentSessionId(), "session-1")
    }

    // MARK: - Same session on quick background→foreground

    func testSameSessionOnQuickResume() {
        let (tracker, _) = makeTracker()
        tracker.onForeground()
        let firstId = tracker.currentSessionId()

        tracker.onBackground()
        tracker.onForeground()

        XCTAssertEqual(tracker.currentSessionId(), firstId)
    }

    // MARK: - New session after timeout

    func testNewSessionAfterTimeout() {
        let (tracker, fakeTimer) = makeTracker()
        tracker.onForeground()
        XCTAssertEqual(tracker.currentSessionId(), "session-1")

        tracker.onBackground()
        fakeTimer.fire() // simulate timeout

        XCTAssertNil(tracker.currentSessionId())

        tracker.onForeground()
        XCTAssertEqual(tracker.currentSessionId(), "session-2")
    }

    // MARK: - Shutdown clears session

    func testShutdownClearsSession() {
        let (tracker, _) = makeTracker()
        tracker.onForeground()
        XCTAssertNotNil(tracker.currentSessionId())

        tracker.shutdown()
        XCTAssertNil(tracker.currentSessionId())
    }

    // MARK: - Shutdown cancels timeout timer

    func testShutdownCancelsTimeoutTimer() {
        let (tracker, fakeTimer) = makeTracker()
        tracker.onForeground()
        tracker.onBackground()

        tracker.shutdown()
        XCTAssertTrue(fakeTimer.isCancelled)

        // Firing after shutdown should not crash or create a session
        fakeTimer.fire()
        XCTAssertNil(tracker.currentSessionId())
    }

    // MARK: - Multiple background calls are idempotent

    func testMultipleBackgroundCallsIdempotent() {
        let (tracker, _) = makeTracker()
        tracker.onForeground()
        tracker.onBackground()
        tracker.onBackground() // second call should be no-op

        XCTAssertEqual(tracker.currentSessionId(), "session-1")
    }

    // MARK: - Stale timer must not end the current session (generation guard)

    /// A timeout timer scheduled in one background cycle must NOT end the session if a
    /// foreground→background round-trip happened after it was scheduled. Without the
    /// generation guard the stale timer sees `state == .backgrounded` again and wrongly
    /// ends the live session, orphaning the current cycle's timer.
    func testStaleTimerDoesNotEndCurrentSession() {
        var timers: [FakeTimer] = []
        var counter = 0
        let tracker = SessionTracker(
            timeoutMs: 30_000,
            uuidProvider: {
                counter += 1
                return "session-\(counter)"
            },
            timerFactory: {
                let timer = FakeTimer()
                timers.append(timer)
                return timer
            }
        )

        tracker.onForeground() // session-1, active
        tracker.onBackground() // timers[0] scheduled for session-1's cycle
        tracker.onForeground() // back to active (session-1 continues)
        tracker.onBackground() // timers[1] scheduled — the current cycle

        XCTAssertEqual(timers.count, 2)

        // Fire the STALE timer from the first cycle.
        timers[0].fire()
        XCTAssertEqual(
            tracker.currentSessionId(),
            "session-1",
            "a stale timer from a previous background cycle must not end the current session"
        )

        // The current cycle's timer still ends the session correctly.
        timers[1].fire()
        XCTAssertNil(tracker.currentSessionId(), "the current cycle's timer ends the session")
    }

}
