import Foundation
import XCTest

@MainActor
final class CtrlProxyWatchUITests: XCTestCase {
    private let commandFailureCoordinator = WatchXCUISource.CommandFailureCoordinator()

    override nonisolated func record(_ issue: XCTIssue) {
        if commandFailureCoordinator.recordDeflectedFailure(issue.compactDescription) {
            return
        }
        super.record(issue)
    }

    func testSnapshotRefusesWhenAppIsNotForeground() throws {
        let environment = ProcessInfo.processInfo.environment
        let app = XCUIApplication(
            bundleIdentifier: environment["AM_BUNDLE_ID"] ?? "dev.jasonpearson.automobile.ctrlproxy.watch"
        )
        app.launch()
        defer { app.activate() }

        let source = WatchXCUISource(app: app, failureCoordinator: commandFailureCoordinator)
        XCTAssertEqual(app.state, .runningForeground)
        let hierarchy = try source.snapshot()
        let root = try XCTUnwrap(hierarchy.root)
        XCTAssertFalse(root.className.isEmpty)

        XCUIDevice.shared.press(.home)
        let leftForeground = XCTNSPredicateExpectation(
            predicate: NSPredicate(
                format: "state != %@",
                NSNumber(value: XCUIApplication.State.runningForeground.rawValue)
            ),
            object: app
        )
        guard XCTWaiter().wait(for: [leftForeground], timeout: 10) == .completed else {
            XCTFail("Watch app remained in the foreground after pressing Home")
            return
        }

        XCTAssertThrowsError(try source.snapshot()) { error in
            guard let commandError = error as? WatchCommandError else {
                XCTFail("Expected WatchCommandError, got \(error)")
                return
            }
            guard case .appNotForeground = commandError else {
                XCTFail("Expected appNotForeground, got \(commandError)")
                return
            }
            XCTAssertEqual(commandError.code, "app_not_foreground")
        }
    }

    /// Host contract: -only-testing:CtrlProxyWatchUITests/CtrlProxyWatchUITests/testRunService
    func testRunService() throws {
        continueAfterFailure = true
        let environment = ProcessInfo.processInfo.environment
        // TEST_RUNNER_AM_PORT is forwarded by XCTest as AM_PORT on watchOS.
        let port = environment["AM_PORT"].flatMap(UInt16.init).flatMap { $0 == 0 ? nil : $0 }
            ?? WatchRunnerService.defaultPort
        let app = XCUIApplication(
            bundleIdentifier: environment["AM_BUNDLE_ID"] ?? "dev.jasonpearson.automobile.ctrlproxy.watch"
        )
        app.launch()
        let source = WatchXCUISource(app: app, failureCoordinator: commandFailureCoordinator)
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let service = try WatchRunnerService(port: port, handler: handler)
        defer { service.stop() }

        let ready = expectation(description: "Watch listener ready")
        let keepAlive = expectation(description: "Watch service lifetime")
        service.start(onReady: { ready.fulfill() }, onFailure: { error in
            XCTFail("Watch listener failed: \(error)")
            keepAlive.fulfill()
        })
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 10), .completed)
        print("CtrlProxy watchOS listening on ws://127.0.0.1:\(port)/ws")

        // XCTest pumps the main queue while waiting; the host stops the runner process.
        XCTAssertEqual(XCTWaiter().wait(for: [keepAlive], timeout: 86400), .timedOut)
    }
}
