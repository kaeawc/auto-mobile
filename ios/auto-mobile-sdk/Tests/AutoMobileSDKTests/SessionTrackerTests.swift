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

}
