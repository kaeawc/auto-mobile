import XCTest

@MainActor
final class CtrlProxyTVUITests: XCTestCase {
    func testRunService() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let value = environment["AM_PORT"], let port = UInt16(value), port > 0 else {
            throw CommandError.invalidParameter("AM_PORT", environment["AM_PORT"] ?? "missing")
        }
        continueAfterFailure = true
        let app = XCUIApplication()
        app.launch()
        let server = try TVWebSocketServer(port: port, router: TVCommandRouter(application: app))
        server.start()
        defer { server.stop() }
        let keepAlive = expectation(description: "CtrlProxy tvOS keep-alive")
        XCTAssertEqual(XCTWaiter().wait(for: [keepAlive], timeout: 86400), .timedOut)
    }
}
