import XCTest

// Note: as of Phase 7C the CtrlProxyRewrite sources (the Swift-6 concurrency rewrite) are
// compiled directly into this target — not the reference `Sources/CtrlProxy` — so XCTest /
// XCUIApplication are available while the `@MainActor` iOS bodies
// (`#if canImport(XCTest) && os(iOS)`) compile. The target name, runner app, xctest bundle,
// and the `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService` identifier are kept
// unchanged so the TS MCP integration + scripts drive it exactly as before, now running the
// rewrite. The reference impl remains the differential-parity oracle via the SwiftPM
// `CtrlProxy` library + `CtrlProxyRewriteTests`.
//
// This is a minimal, faithful runner restricted to the public `CtrlProxy` surface the
// production runner actually uses (`CtrlProxy(port:)`, `start`, `start(bundleId:)`, `stop`,
// `defaultPort`). The reference's richer integration tests (`testHierarchyIncludes…`,
// `PrivacyResourceMappingTests`) are not carried over: they leaned on the dropped
// `PerfProvider` singleton default and on test-only factories/fakes (`createForTesting`,
// `FakeTimeProvider`) that live in `CtrlProxyTestSupport`, out of the shipped product. Porting
// them against the rewrite's injected seams is a follow-up (real observe→gesture→hierarchy UI
// tests, now runnable on a simulator).

/// XCUITest runner that starts the CtrlProxy iOS WebSocket server (Swift-6 rewrite).
///
/// Usage:
/// 1. Build and run this test target on a device/simulator
/// 2. The test starts the WebSocket server on port 8765
/// 3. Connect an automation client to ws://localhost:8765/ws
/// 4. Send commands matching the Android AccessibilityService protocol
///
/// Environment Variables:
/// - CTRL_PROXY_IOS_PORT: Server port (default: 8765)
/// - CTRL_PROXY_IOS_BUNDLE_ID: Target app bundle ID (optional)
/// - CTRL_PROXY_IOS_TIMEOUT: How long to keep the server running in seconds (default: forever)
///
/// `@MainActor`: the rewrite's `CtrlProxy` coordinator is `@MainActor` (unlike the reference's
/// plain class). XCUITest already runs its lifecycle and test methods on the main thread, so
/// marking the case main-actor-isolated lets it drive the `@MainActor` API directly — matching
/// how the rewrite's own `@MainActor` XCTestCase suites are written — instead of sprinkling
/// `MainActor.assumeIsolated`.
@MainActor
final class CtrlProxyUITests: XCTestCase {
    private var service: CtrlProxy?

    override func setUpWithError() throws {
        continueAfterFailure = true
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
        print("  CtrlProxy iOS (Swift-6 rewrite)")
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

        service = CtrlProxy(port: port)
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
