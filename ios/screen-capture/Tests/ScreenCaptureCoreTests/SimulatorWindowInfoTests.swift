import XCTest
@testable import ScreenCaptureCore

final class SimulatorWindowInfoTests: XCTestCase {
    func testRoundTripsThroughJSON() throws {
        let original = SimulatorWindowListResponse(windows: [
            SimulatorWindowInfo(
                windowID: 12345,
                title: "iPhone 15 Pro — iOS 17.4",
                applicationName: "Simulator",
                bundleIdentifier: simulatorBundleIdentifier,
                processID: 4242,
                width: 1170,
                height: 2532
            )
        ])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SimulatorWindowListResponse.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func testTitleMayBeNil() throws {
        let info = SimulatorWindowInfo(
            windowID: 1,
            title: nil,
            applicationName: "Simulator",
            bundleIdentifier: simulatorBundleIdentifier,
            processID: 1,
            width: 0,
            height: 0
        )
        let data = try JSONEncoder().encode(info)
        let decoded = try JSONDecoder().decode(SimulatorWindowInfo.self, from: data)
        XCTAssertNil(decoded.title)
    }

    func testSimulatorBundleIdentifierConstant() {
        XCTAssertEqual(simulatorBundleIdentifier, "com.apple.iphonesimulator")
    }
}
