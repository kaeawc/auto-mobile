@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class AppStateWaitTests: XCTestCase {
    func testMainActorMakesProgressWhilePollIsSuspended() async {
        let clock = KeyboardTestClock(manual: true)
        var probes = 0
        var finished = false
        let task = Task { @MainActor in
            let result = await AppStateWait.poll(clock: clock) {
                probes += 1
                return probes == 2
            }
            finished = true
            return result
        }

        await clock.waitUntilSleeping()
        XCTAssertEqual(probes, 1)
        XCTAssertFalse(finished)
        XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
        clock.release()
        let result = await task.value
        XCTAssertTrue(result)
        XCTAssertTrue(finished)
        XCTAssertEqual(probes, 2)
        XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
    }

    func testExhaustionDoesNotSleepAfterFinalProbe() async {
        let clock = KeyboardTestClock()
        var probes = 0
        let result = await AppStateWait.poll(clock: clock) {
            probes += 1
            return false
        }

        XCTAssertFalse(result)
        XCTAssertEqual(probes, 10)
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(50), count: 9))
    }

    func testImmediateMatchDoesNotSleep() async {
        let clock = KeyboardTestClock()
        var probes = 0
        let result = await AppStateWait.poll(clock: clock) {
            probes += 1
            return true
        }

        XCTAssertTrue(result)
        XCTAssertEqual(probes, 1)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testCancellationDuringSleepStopsProbing() async {
        let clock = KeyboardTestClock(manual: true)
        var probes = 0
        let task = Task { @MainActor in
            await AppStateWait.poll(clock: clock) {
                probes += 1
                return false
            }
        }

        await clock.waitUntilSleeping()
        task.cancel()
        let result = await task.value
        XCTAssertFalse(result)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
    }

    func testMatchesPreservesRawStateRules() {
        for rawState: UInt in 0 ... 5 {
            XCTAssertEqual(AppStateWait.matches(rawState: rawState, expected: .foreground), rawState >= 4)
            XCTAssertEqual(AppStateWait.matches(rawState: rawState, expected: .notRunning), rawState <= 1)
            XCTAssertEqual(AppStateWait.matches(rawState: rawState, expected: .background), rawState == 3)
        }
    }

    func testCustomAttemptsAndInterval() async {
        let clock = KeyboardTestClock()
        var probes = 0
        let result = await AppStateWait.poll(clock: clock, attempts: 3, interval: .milliseconds(20)) {
            probes += 1
            return false
        }

        XCTAssertFalse(result)
        XCTAssertEqual(probes, 3)
        XCTAssertEqual(clock.sleeps, [.milliseconds(20), .milliseconds(20)])
    }

    func testNonPositiveAttemptsDoNotProbeOrSleep() async {
        for attempts in [0, -1] {
            let clock = KeyboardTestClock()
            var probes = 0
            let result = await AppStateWait.poll(clock: clock, attempts: attempts) {
                probes += 1
                return true
            }

            XCTAssertFalse(result)
            XCTAssertEqual(probes, 0)
            XCTAssertTrue(clock.sleeps.isEmpty)
        }
    }
}
