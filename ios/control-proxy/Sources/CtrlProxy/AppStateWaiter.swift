import Foundation

/// Raw XCUIApplication lifecycle state; zero means the state could not be read.
@MainActor
protocol AppStateProbing {
    func rawState(bundleId: String) -> UInt
}

/// The platform-neutral lifecycle path shared by the XCUI locator and host tests.
@MainActor
struct AppStateWaiter {
    let clock: any Clock<Duration>
    let probe: any AppStateProbing

    func awaitAppState(bundleId: String, expectedState: AppStateExpectation) async -> Bool {
        await AppStateWait.poll(clock: clock) {
            AppStateWait.matches(rawState: probe.rawState(bundleId: bundleId), expected: expectedState)
        }
    }

    func observedState(bundleId: String) -> ObservedAppState {
        switch probe.rawState(bundleId: bundleId) {
        case 0: .unknown
        case 1: .notRunning
        case 2: .runningBackgroundSuspended
        case 3: .runningBackground
        default: .runningForeground
        }
    }
}
