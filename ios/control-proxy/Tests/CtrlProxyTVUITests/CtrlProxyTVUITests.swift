import XCTest

@MainActor
final class CtrlProxyTVUITests: XCTestCase {
    func testRunService() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let value = environment["AM_PORT"] else {
            throw XCTSkip("AM_PORT is not set; run testRunService with TEST_RUNNER_AM_PORT to start the tvOS runner.")
        }
        guard let port = UInt16(value), port > 0 else {
            throw CommandError.invalidParameter("AM_PORT", value)
        }
        continueAfterFailure = true
        let app = XCUIApplication()
        app.launch()
        let server = try TVWebSocketServer(port: port, router: TVCommandRouter(application: app))
        let keepAlive = expectation(description: "CtrlProxy tvOS keep-alive")
        server.start(onFailure: { keepAlive.fulfill() })
        defer { server.stop() }
        XCTAssertEqual(XCTWaiter().wait(for: [keepAlive], timeout: 86400), .timedOut, "tvOS listener failed")
    }
}
