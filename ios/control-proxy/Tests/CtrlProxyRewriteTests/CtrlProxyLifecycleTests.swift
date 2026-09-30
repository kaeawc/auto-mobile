@testable import CtrlProxyRewrite
import os
import XCTest

final class CtrlProxyStartupActivationTests: XCTestCase {
    func testExplicitBundleIdActivatesAndTracksRequestedApp() {
        let plan = CtrlProxy.startupActivationPlan(
            explicitBundleId: "com.example.requested",
            detectedForeground: "com.example.foreground"
        )
        XCTAssertEqual(plan.activate, "com.example.requested")
        XCTAssertEqual(plan.track, "com.example.requested")
    }

    func testDetectedForegroundIsTrackedWithoutActivation() {
        let plan = CtrlProxy.startupActivationPlan(
            explicitBundleId: nil,
            detectedForeground: "com.example.foreground"
        )
        XCTAssertNil(plan.activate)
        XCTAssertEqual(plan.track, "com.example.foreground")
    }

    func testDetectionMissTracksSpringboardWithoutActivation() {
        let plan = CtrlProxy.startupActivationPlan(explicitBundleId: nil, detectedForeground: nil)
        XCTAssertNil(plan.activate)
        XCTAssertEqual(plan.track, CtrlProxy.defaultBundleId)
    }
}

@MainActor
final class CtrlProxyLifecycleTests: XCTestCase {
    private final class FakeServer: Sendable {
        let connected = OSAllocatedUnfairLock(initialState: false)
        let failsToStart = OSAllocatedUnfairLock(initialState: false)
        enum Failure: Error { case start }
        func start() throws {
            if failsToStart.withLock({ $0 }) { throw Failure.start }
        }
    }

    private func makeProxy(_ server: FakeServer) -> CtrlProxy {
        CtrlProxy(
            hierarchyPollTimer: FakeProxyTimer(mode: .manual),
            hasClients: { server.connected.withLock { $0 } },
            startServer: { try server.start() }
        )
    }

    func testQueuedPresenceCallbackDoesNotRestartSamplersAfterStop() throws {
        let server = FakeServer()
        let proxy = makeProxy(server)
        try proxy.start()
        server.connected.withLock { $0 = true }
        proxy.applyClientPresence()
        XCTAssertTrue(proxy.samplersActive)
        proxy.stop()
        proxy.applyClientPresence()
        XCTAssertFalse(proxy.samplersActive)
    }

    func testOldCallbackAfterRestartUsesNewServerPresence() throws {
        let server = FakeServer()
        let proxy = makeProxy(server)
        try proxy.start()
        server.connected.withLock { $0 = true }
        proxy.stop()
        server.connected.withLock { $0 = false }
        try proxy.start()
        proxy.applyClientPresence()
        XCTAssertFalse(proxy.samplersActive)
    }

    func testQueuedPresenceAfterFailedStartDoesNotSample() throws {
        let server = FakeServer()
        let proxy = makeProxy(server)
        try proxy.start()
        proxy.stop()
        server.failsToStart.withLock { $0 = true }
        server.connected.withLock { $0 = true }
        XCTAssertThrowsError(try proxy.start())
        proxy.applyClientPresence()
        XCTAssertFalse(proxy.samplersActive)
    }

    func testReversedRapidTransitionsAlwaysUseCurrentPresence() throws {
        let server = FakeServer()
        let proxy = makeProxy(server)
        try proxy.start()
        defer { proxy.stop() }
        // false/true notifications both queued; deliver either one first.
        server.connected.withLock { $0 = false }
        server.connected.withLock { $0 = true }
        proxy.applyClientPresence()
        proxy.applyClientPresence()
        XCTAssertTrue(proxy.samplersActive)
        // true/false notifications both queued; even the old true sees false.
        server.connected.withLock { $0 = true }
        server.connected.withLock { $0 = false }
        proxy.applyClientPresence()
        proxy.applyClientPresence()
        XCTAssertFalse(proxy.samplersActive)
    }
}
