import XCTest

@MainActor
final class CtrlProxyVisionUITests: XCTestCase {
    func testRunService() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let value = environment["AM_PORT"] else {
            throw XCTSkip(
                "AM_PORT is not set; run testRunService with TEST_RUNNER_AM_PORT to start the visionOS runner."
            )
        }
        guard let port = UInt16(value), port > 0 else {
            throw CommandError.invalidParameter("AM_PORT", value)
        }
        continueAfterFailure = true
        // Automate the user's window app when the daemon names it; activate (never relaunch) so
        // the app already on screen keeps its state. Without a bundle id use the demo app.
        let app: XCUIApplication
        if let bundleId = VisionCommandPolicy.targetBundleId(environment: environment) {
            app = XCUIApplication(bundleIdentifier: bundleId)
            app.activate()
        } else {
            app = XCUIApplication()
            app.launch()
        }
        let server = try VisionWebSocketServer(port: port, router: VisionCommandRouter(application: app))
        let keepAlive = expectation(description: "CtrlProxy visionOS keep-alive")
        server.start(onFailure: { keepAlive.fulfill() })
        defer { server.stop() }
        XCTAssertEqual(XCTWaiter().wait(for: [keepAlive], timeout: 86400), .timedOut, "visionOS listener failed")
    }
}
