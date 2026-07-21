import XCTest
@testable import ScreenCaptureCore

final class SimulatorAudioCaptureAvailabilityTests: XCTestCase {
    func testAllowsAudioWhenExactlyOneSimulatorWindowIsVisible() {
        XCTAssertNil(SimulatorAudioCaptureAvailability.errorMessage(for: [window(id: 1)]))
    }

    func testRejectsAudioWhenMultipleSimulatorWindowsAreVisible() {
        XCTAssertEqual(
            SimulatorAudioCaptureAvailability.errorMessage(for: [window(id: 1), window(id: 2)]),
            "iOS Simulator audio capture requires exactly one visible Simulator window because ScreenCaptureKit cannot isolate audio to a selected Simulator window. Close other Simulator windows and try again."
        )
    }

    private func window(id: UInt32) -> SimulatorWindowInfo {
        SimulatorWindowInfo(
            windowID: id,
            title: "iPhone",
            applicationName: "Simulator",
            bundleIdentifier: simulatorBundleIdentifier,
            processID: 1,
            width: 390,
            height: 844
        )
    }
}
