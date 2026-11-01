import Foundation
import XCTest

@MainActor
final class CtrlProxyWatchUITests: XCTestCase {
    /// Host contract: -only-testing:CtrlProxyWatchUITests/CtrlProxyWatchUITests/testRunService
    func testRunService() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        // TEST_RUNNER_AM_PORT is forwarded by XCTest as AM_PORT on watchOS.
        let port = environment["AM_PORT"].flatMap(UInt16.init).flatMap { $0 == 0 ? nil : $0 }
            ?? WatchRunnerService.defaultPort
        let app = XCUIApplication(
            bundleIdentifier: environment["AM_BUNDLE_ID"] ?? "dev.jasonpearson.automobile.ctrlproxy.watch"
        )
        app.launch()
        let source = WatchXCUISource(app: app)
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let service = try WatchRunnerService(port: port, handler: handler)
        defer { service.stop() }

        let ready = expectation(description: "Watch listener ready")
        service.start(onReady: { ready.fulfill() }, onFailure: { error in
            XCTFail("Watch listener failed: \(error)")
        })
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 10), .completed)
        print("CtrlProxy watchOS listening on ws://127.0.0.1:\(port)/ws")

        // XCTest pumps the main queue while waiting; the host stops the runner process.
        let keepAlive = expectation(description: "Watch service lifetime")
        XCTAssertEqual(XCTWaiter().wait(for: [keepAlive], timeout: 86400), .timedOut)
    }
}
