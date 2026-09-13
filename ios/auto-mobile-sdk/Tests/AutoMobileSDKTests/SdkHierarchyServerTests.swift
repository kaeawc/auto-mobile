@testable import AutoMobileSDK
import Foundation
import Network
import XCTest

final class SdkHierarchyServerTests: XCTestCase {
    private final class FakeHierarchyTracker: SdkHierarchyServing {
        var bundleId: String? {
            "test.bundle"
        }
        var isApplicationActive: Bool { true }

        func getLatestHierarchy() -> SdkViewHierarchy? {
            nil
        }

        func walkNow() -> SdkViewHierarchy {
            fatalError("The lifecycle test does not request a hierarchy")
        }
    }

    private final class TrackingLock: NSLocking, @unchecked Sendable {
        private let underlyingLock = NSLock()
        private let stateLock = NSLock()
        private var _isLocked = false

        /// Signals when another caller tries to acquire the lock while it is held.
        let didAttemptLockWhileHeld = DispatchSemaphore(value: 0)

        var isLocked: Bool {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isLocked
        }

        func lock() {
            stateLock.lock()
            let wasLocked = _isLocked
            stateLock.unlock()
            if wasLocked {
                didAttemptLockWhileHeld.signal()
            }

            underlyingLock.lock()
            stateLock.lock()
            _isLocked = true
            stateLock.unlock()
        }

        func unlock() {
            stateLock.lock()
            _isLocked = false
            stateLock.unlock()
            underlyingLock.unlock()
        }
    }

    /// A listener whose `start(queue:)` cannot finish until the test permits it.
    /// This lets the test inspect the lifecycle lock while `start()` is in its
    /// critical section without binding a real network port.
    private final class BlockingListener: SdkHierarchyListener, @unchecked Sendable {
        var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)?
        var newConnectionHandler: (@Sendable (NWConnection) -> Void)?

        private let stateLock = NSLock()
        private var _isServing = false
        private var _cancelCallCount = 0

        let didEnterStart = DispatchSemaphore(value: 0)
        let mayFinishStart = DispatchSemaphore(value: 0)

        var isServing: Bool {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isServing
        }

        var cancelCallCount: Int {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _cancelCallCount
        }

        func start(queue _: DispatchQueue) {
            didEnterStart.signal()
            mayFinishStart.wait()

            stateLock.lock()
            _isServing = true
            stateLock.unlock()
        }

        func cancel() {
            stateLock.lock()
            _cancelCallCount += 1
            _isServing = false
            stateLock.unlock()
        }
    }

    func testStartKeepsLifecycleLockThroughListenerStartThenStopCancelsListener() {
        let tracker = FakeHierarchyTracker()
        let listener = BlockingListener()
        let lifecycleLock = TrackingLock()
        let server = SdkHierarchyServer(
            tracker: tracker,
            listenerFactory: { listener },
            lifecycleLock: lifecycleLock
        )
        let startReturned = expectation(description: "start returns after the listener starts")
        let stopReturned = expectation(description: "stop returns after cancelling the listener")

        DispatchQueue.global().async {
            server.start()
            startReturned.fulfill()
        }
        XCTAssertEqual(
            listener.didEnterStart.wait(timeout: .now() + 1),
            .success,
            "listener start should be entered"
        )
        XCTAssertTrue(
            lifecycleLock.isLocked,
            "start must retain the lifecycle lock while the listener starts"
        )

        DispatchQueue.global().async {
            server.stop()
            stopReturned.fulfill()
        }

        XCTAssertEqual(
            lifecycleLock.didAttemptLockWhileHeld.wait(timeout: .now() + 1),
            .success,
            "stop must attempt to acquire the lifecycle lock before listener startup can finish"
        )
        listener.mayFinishStart.signal()
        wait(for: [startReturned, stopReturned], timeout: 1)

        XCTAssertEqual(listener.cancelCallCount, 1)
        XCTAssertFalse(listener.isServing, "teardown must not leave a listener serving")
    }

    /// Reports the app as active exactly once — the header-parse check — and
    /// inactive on every later read. Models an app that resigns active while the
    /// request body is still arriving.
    private final class ResignsAfterHeadersTracker: SdkHierarchyServing, @unchecked Sendable {
        private let stateLock = NSLock()
        private var reads = 0

        var readCount: Int {
            stateLock.lock()
            defer { stateLock.unlock() }
            return reads
        }

        var bundleId: String? { "test.bundle" }

        var isApplicationActive: Bool {
            stateLock.lock()
            defer { stateLock.unlock() }
            reads += 1
            return reads == 1
        }

        func getLatestHierarchy() -> SdkViewHierarchy? { nil }

        /// The foreground gate answers before any route runs, so this is never
        /// reached; returning an empty snapshot keeps the fake total.
        func walkNow() -> SdkViewHierarchy {
            XCTFail("The foreground gate must answer before a route walks the hierarchy")
            return SdkViewHierarchy(screenScale: 1, screenWidth: 0, screenHeight: 0, root: nil)
        }
    }

    /// Wraps a real loopback `NWListener` on an ephemeral port so the server's own
    /// routing runs end to end without binding the fixed port 8766.
    private final class LoopbackListener: SdkHierarchyListener, @unchecked Sendable {
        private let listener: NWListener
        let didBecomeReady = DispatchSemaphore(value: 0)

        var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)?
        var newConnectionHandler: (@Sendable (NWConnection) -> Void)?

        init() throws {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            listener = try NWListener(using: parameters, on: .any)
        }

        var boundPort: NWEndpoint.Port? { listener.port }

        func start(queue: DispatchQueue) {
            let forwarded = stateUpdateHandler
            let ready = didBecomeReady
            listener.stateUpdateHandler = { state in
                forwarded?(state)
                if case .ready = state { ready.signal() }
            }
            listener.newConnectionHandler = newConnectionHandler
            listener.start(queue: queue)
        }

        func cancel() {
            listener.cancel()
        }
    }

    /// Sends `head`, then `body` as a separate write, and returns the full response.
    private func roundTrip(port: NWEndpoint.Port, head: String, body: String) throws -> String {
        let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        let queue = DispatchQueue(label: "sdk-hierarchy-server-test-client")
        let responded = expectation(description: "server responds")
        let responseLock = NSLock()
        var response = Data()

        func receive() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                if let data = data, !data.isEmpty {
                    responseLock.lock()
                    response.append(data)
                    responseLock.unlock()
                }
                if isComplete || error != nil {
                    responded.fulfill()
                    return
                }
                receive()
            }
        }

        connection.stateUpdateHandler = { state in
            guard case .ready = state else { return }
            connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
                connection.send(content: Data(body.utf8), completion: .contentProcessed { _ in })
            })
            receive()
        }
        connection.start(queue: queue)
        wait(for: [responded], timeout: 5)
        connection.cancel()

        responseLock.lock()
        defer { responseLock.unlock() }
        return String(data: response, encoding: .utf8) ?? ""
    }

    private func withRunningServer(
        tracker: any SdkHierarchyServing,
        _ body: (NWEndpoint.Port) throws -> Void
    ) throws {
        let listener = try LoopbackListener()
        let server = SdkHierarchyServer(tracker: tracker, listenerFactory: { listener })
        server.start()
        defer { server.stop() }

        XCTAssertEqual(listener.didBecomeReady.wait(timeout: .now() + 5), .success, "listener should bind")
        guard let port = listener.boundPort else {
            XCTFail("listener reported no bound port")
            return
        }
        try body(port)
    }

    /// A body-bearing route must re-check the foreground gate AFTER the body is
    /// read: the headers can land while the app is active and the body arrive
    /// only after it resigned, so trusting the header-time check alone would let
    /// a background app be mutated.
    func testBespokeBodyRouteRechecksForegroundAfterTheBodyArrives() throws {
        let tracker = ResignsAfterHeadersTracker()
        let payload = "{\"rules\":[]}"
        try withRunningServer(tracker: tracker) { port in
            let response = try roundTrip(
                port: port,
                head: "POST /network/mock HTTP/1.1\r\nHost: localhost\r\nContent-Length: \(payload.utf8.count)\r\n\r\n",
                body: payload
            )
            XCTAssertTrue(response.contains("409 Conflict"), "expected a 409, got: \(response)")
            XCTAssertTrue(response.contains("app_not_active"), "expected app_not_active, got: \(response)")
        }
        XCTAssertGreaterThanOrEqual(
            tracker.readCount,
            2,
            "the gate must be read again at route-execution time, not only at header-parse time"
        )
    }

    /// Same invariant for the generic `handleBodyRoute` path the database routes use.
    func testGenericBodyRouteRechecksForegroundAfterTheBodyArrives() throws {
        let tracker = ResignsAfterHeadersTracker()
        let payload = "{\"appId\":\"test.bundle\"}"
        try withRunningServer(tracker: tracker) { port in
            let response = try roundTrip(
                port: port,
                head: "POST /db/tables HTTP/1.1\r\nHost: localhost\r\nContent-Length: \(payload.utf8.count)\r\n\r\n",
                body: payload
            )
            XCTAssertTrue(response.contains("409 Conflict"), "expected a 409, got: \(response)")
            XCTAssertTrue(response.contains("app_not_active"), "expected app_not_active, got: \(response)")
        }
    }
}
