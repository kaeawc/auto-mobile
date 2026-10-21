@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class ScriptedAppStateProbe: AppStateProbing {
    var states: [UInt]
    private(set) var bundleIds: [String] = []

    init(states: [UInt] = [4]) {
        precondition(!states.isEmpty)
        self.states = states
    }

    func rawState(bundleId: String) -> UInt {
        bundleIds.append(bundleId)
        if states.count > 1 { return states.removeFirst() }
        return states[0]
    }
}

@MainActor
final class AppStateWaiterTests: XCTestCase {
    func testForegroundPollReadsRequestedBundleThroughStateSequence() async {
        let clock = KeyboardTestClock()
        let probe = ScriptedAppStateProbe(states: [1, 2, 4])
        let waiter = AppStateWaiter(clock: clock, probe: probe)

        let result = await waiter.awaitAppState(bundleId: "com.example.app", expectedState: .foreground)

        XCTAssertTrue(result)
        XCTAssertEqual(probe.bundleIds, Array(repeating: "com.example.app", count: 3))
        XCTAssertEqual(clock.sleeps, [.milliseconds(50), .milliseconds(50)])
    }

    func testExpectationMappingThroughWaiter() async {
        let cases: [(AppStateExpectation, [UInt])] = [
            (.notRunning, [0, 1]), (.background, [3]), (.foreground, [4, 5]),
        ]
        for (expectation, matchingStates) in cases {
            for raw: UInt in 0 ... 5 {
                let clock = KeyboardTestClock()
                let probe = ScriptedAppStateProbe(states: [raw])
                let waiter = AppStateWaiter(clock: clock, probe: probe)
                let matches = matchingStates.contains(raw)

                let result = await waiter.awaitAppState(bundleId: "com.example.app", expectedState: expectation)

                XCTAssertEqual(result, matches, "raw=\(raw), expectation=\(expectation)")
                XCTAssertEqual(probe.bundleIds.count, matches ? 1 : 10)
                XCTAssertEqual(clock.sleeps.count, matches ? 0 : 9)
            }
        }
    }

    func testNeverMatchingProbeExhaustsTenAttemptsWithoutFinalSleep() async {
        let clock = KeyboardTestClock()
        let probe = ScriptedAppStateProbe(states: [1])
        let waiter = AppStateWaiter(clock: clock, probe: probe)

        let result = await waiter.awaitAppState(bundleId: "com.example.app", expectedState: .foreground)

        XCTAssertFalse(result)
        XCTAssertEqual(probe.bundleIds, Array(repeating: "com.example.app", count: 10))
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(50), count: 9))
    }

    func testAnotherMainActorTaskCompletesBeforeSleepIsReleased() async {
        let clock = KeyboardTestClock(manual: true)
        let probe = ScriptedAppStateProbe(states: [1, 4])
        let waiter = AppStateWaiter(clock: clock, probe: probe)
        var finished = false
        let task = Task { @MainActor in
            let result = await waiter.awaitAppState(bundleId: "com.example.app", expectedState: .foreground)
            finished = true
            return result
        }

        await clock.waitUntilSleeping()
        var secondTaskFinished = false
        await Task { @MainActor in secondTaskFinished = true }.value
        XCTAssertTrue(secondTaskFinished)
        XCTAssertFalse(finished)
        XCTAssertEqual(probe.bundleIds.count, 1)
        clock.release()
        let result = await task.value
        XCTAssertTrue(result)
        XCTAssertTrue(finished)
        XCTAssertEqual(probe.bundleIds.count, 2)
    }

    func testCancellationDuringSleepStopsBeforeNextProbe() async {
        let clock = KeyboardTestClock(manual: true)
        let probe = ScriptedAppStateProbe(states: [1, 4])
        let waiter = AppStateWaiter(clock: clock, probe: probe)
        let task = Task { @MainActor in
            await waiter.awaitAppState(bundleId: "com.example.app", expectedState: .foreground)
        }

        await clock.waitUntilSleeping()
        task.cancel()
        let result = await task.value
        XCTAssertFalse(result)
        XCTAssertEqual(probe.bundleIds, ["com.example.app"])
        XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
    }

    func testObservedStateMapping() {
        let expected: [ObservedAppState] = [
            .unknown, .notRunning, .runningBackgroundSuspended, .runningBackground,
            .runningForeground, .runningForeground,
        ]
        for raw: UInt in 0 ... 5 {
            let probe = ScriptedAppStateProbe(states: [raw])
            let waiter = AppStateWaiter(clock: KeyboardTestClock(), probe: probe)
            XCTAssertEqual(waiter.observedState(bundleId: "com.example.app"), expected[Int(raw)])
            XCTAssertEqual(probe.bundleIds, ["com.example.app"])
        }
    }
}
