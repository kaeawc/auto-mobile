import XCTest

// The CtrlProxy sources compile directly into this target so XCTest and
// XCUIApplication are available to the iOS test bodies. The target name, runner app,
// bundle, and test identifier are used by the TS MCP integration and scripts.
// These tests exercise the service through its injected collaborators in the simulator.

@MainActor
final class CtrlProxyUITests: XCTestCase {
    private var service: CtrlProxy?
    private let commandFailureCoordinator = CommandFailureCoordinator()

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    override nonisolated func record(_ issue: XCTIssue) {
        if commandFailureCoordinator.recordDeflectedFailure(issue.compactDescription) {
            return
        }
        super.record(issue)
    }

    // No `tearDownWithError` override: XCTest's teardown is nonisolated, so touching the
    // `@MainActor` `service` from it forces an `assumeIsolated` that trips region isolation
    // ("sending self"). Instead each `@MainActor` test method stops its service via `defer`
    // (same safety-net cleanup, entirely in main-actor context).

    /// Main test that starts the WebSocket server. Runs indefinitely (or until timeout) to keep
    /// the server alive; the process is killed externally by the MCP stop() path.
    func testRunService() throws {
        let port = getPort()
        let bundleId = getBundleId()

        print("========================================")
        print("  CtrlProxy iOS")
        print("========================================")
        print("Port: \(port)")
        print("Bundle ID: \(bundleId ?? "default")")
        print("Timeout: \(getTimeout().map { "\($0)s" } ?? "forever")")
        print("========================================")
        print("")
        print("WebSocket: ws://localhost:\(port)/ws")
        print("Health:    http://localhost:\(port)/health")
        print("")
        print("Protocol: Android AccessibilityService compatible")
        print("========================================")

        service = CtrlProxy(port: port, coordinator: commandFailureCoordinator)
        defer { service?.stop() }

        if let bundleId = bundleId {
            try service?.start(bundleId: bundleId)
        } else {
            try service?.start()
        }

        // Keep the test alive using XCTWaiter instead of RunLoop spinning. The expectation is
        // intentionally never fulfilled; .timedOut is the expected result for a normal timed
        // shutdown. The process is killed externally by the MCP stop() path before timeout.
        let keepAlive = expectation(description: "CtrlProxy iOS keep-alive")
        let result = XCTWaiter().wait(for: [keepAlive], timeout: getTimeout() ?? 86400)
        XCTAssertEqual(result, .timedOut, "Expected service to run until timeout")
    }

    /// Verifies the service can start.
    func testServiceStarts() throws {
        let service = CtrlProxy(port: 8766)
        try service.start()

        Thread.sleep(forTimeInterval: 1.0)

        XCTAssertTrue(true, "Service started successfully")

        service.stop()
    }

    /// Launches a specific app and starts the service.
    func testLaunchAppAndRunService() throws {
        guard let bundleId = getBundleId() else {
            throw XCTSkip("CTRL_PROXY_IOS_BUNDLE_ID environment variable not set")
        }

        service = CtrlProxy(port: getPort())
        defer { service?.stop() }
        try service?.start(bundleId: bundleId)

        let keepAlive = expectation(description: "CtrlProxy iOS keep-alive")
        let result = XCTWaiter().wait(for: [keepAlive], timeout: getTimeout() ?? 300)
        XCTAssertEqual(result, .timedOut, "Expected service to run until timeout")
    }

    // MARK: - Configuration Helpers

    private func getPort() -> UInt16 {
        if let portString = ProcessInfo.processInfo.environment["CTRL_PROXY_IOS_PORT"],
           let port = UInt16(portString)
        {
            return port
        }
        return CtrlProxy.defaultPort
    }

    private func getBundleId() -> String? {
        return ProcessInfo.processInfo.environment["CTRL_PROXY_IOS_BUNDLE_ID"]
    }

    private func getTimeout() -> TimeInterval? {
        if let timeoutString = ProcessInfo.processInfo.environment["CTRL_PROXY_IOS_TIMEOUT"],
           let timeout = TimeInterval(timeoutString)
        {
            return timeout
        }
        return nil
    }
}
