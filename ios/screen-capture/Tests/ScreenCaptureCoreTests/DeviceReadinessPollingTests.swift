import XCTest
@testable import ScreenCaptureCore

final class DeviceReadinessPollingTests: XCTestCase {
    /// A fake clock/sleep pair: `sleep` advances the virtual clock so the loop
    /// terminates deterministically without real wall-clock time.
    private final class FakeClock {
        private(set) var current: TimeInterval = 0
        private(set) var sleepCalls = 0

        func now() -> TimeInterval { current }

        func sleep(_ seconds: TimeInterval) {
            sleepCalls += 1
            current += seconds
        }
    }

    func testReturnsImmediatelyWhenReadyUpFront() {
        let clock = FakeClock()
        let result = DeviceReadinessPolling.waitUntilReady(
            now: clock.now,
            sleep: clock.sleep,
            isReady: { true }
        )
        XCTAssertTrue(result)
        XCTAssertEqual(clock.sleepCalls, 0, "should not sleep when device is already present")
    }

    func testReturnsTrueAsSoonAsDeviceAppears() {
        let clock = FakeClock()
        var probes = 0
        let result = DeviceReadinessPolling.waitUntilReady(
            deadline: 0.5,
            interval: 0.125,
            now: clock.now,
            sleep: clock.sleep,
            isReady: {
                probes += 1
                return probes >= 3
            }
        )
        XCTAssertTrue(result)
        // Ready on the 3rd probe: immediate probe + 2 poll iterations.
        XCTAssertEqual(clock.sleepCalls, 2)
    }

    func testReturnsFalseWhenDeadlineLapses() {
        let clock = FakeClock()
        // Binary-exact interval so the accumulated clock hits the deadline
        // precisely (no floating-point drift adding a spurious final probe).
        let result = DeviceReadinessPolling.waitUntilReady(
            deadline: 0.5,
            interval: 0.125,
            now: clock.now,
            sleep: clock.sleep,
            isReady: { false }
        )
        XCTAssertFalse(result)
        // 0.5s budget / 0.125s interval = 4 sleeps before the deadline lapses.
        XCTAssertEqual(clock.sleepCalls, 4)
    }

    func testNeverSleepsPastTheDeadline() {
        let clock = FakeClock()
        _ = DeviceReadinessPolling.waitUntilReady(
            deadline: 0.5,
            interval: 0.2,
            now: clock.now,
            sleep: clock.sleep,
            isReady: { false }
        )
        XCTAssertLessThanOrEqual(clock.current, 0.5, "must not overshoot the deadline")
    }
}
