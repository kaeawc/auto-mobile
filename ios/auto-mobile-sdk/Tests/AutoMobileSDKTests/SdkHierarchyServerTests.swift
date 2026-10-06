@testable import AutoMobileSDK
import Foundation
import Network
import XCTest

final class SdkHierarchyServerTests: XCTestCase {
    func testListenerRequiresLoopbackEndpoint() {
        guard case let .hostPort(host, port)? = SdkHierarchyServer.listenerParameters().requiredLocalEndpoint else {
            return XCTFail("Expected a local host and port")
        }
        XCTAssertEqual(host.debugDescription, "127.0.0.1")
        XCTAssertEqual(port.rawValue, SdkHierarchyServer.port)
    }

    func testRealLoopbackListenerBecomesReady() throws {
        let listener = try SdkHierarchyServer.makeListener(port: 0)
        let ready = expectation(description: "real loopback listener becomes ready")
        listener.stateUpdateHandler = { state in
            if case .ready = state {
                ready.fulfill()
            }
        }
        listener.newConnectionHandler = { connection in
            connection.cancel()
        }
        listener.start(queue: DispatchQueue(label: "sdk-hierarchy-listener-test"))
        defer { listener.cancel() }

        wait(for: [ready], timeout: 5)
    }

    func testExactRequestLineRoutes() {
        let routes: [(String, SdkHierarchyServer.Route)] = [
            ("GET /hierarchy", .cachedHierarchy),
            ("GET /hierarchy/fresh", .freshHierarchy),
            ("GET /health", .health),
            ("POST /network/mock", .networkMock),
            ("POST /network/error-simulation", .networkErrorSimulation),
            ("POST /network/fault-rules", .networkFaultRules),
            ("POST /highlight", .highlight),
            ("POST /db/execute", .dbExecute),
            ("POST /db/list", .dbList),
            ("POST /db/capabilities", .dbCapabilities),
            ("POST /db/tables", .dbTables),
            ("POST /db/table-data", .dbTableData),
            ("POST /db/table-structure", .dbTableStructure),
            ("POST /preferences", .preferences),
        ]
        for (request, route) in routes {
            XCTAssertEqual(SdkHierarchyServer.route(forRequestLine: "\(request) HTTP/1.1"), .matched(route), request)
        }
    }

    func testRequestLineStripsQueryAndFragment() {
        XCTAssertEqual(
            SdkHierarchyServer.route(forRequestLine: "GET /health?x=GET%20/hierarchy/fresh HTTP/1.1"),
            .matched(.health)
        )
        XCTAssertEqual(
            SdkHierarchyServer.route(forRequestLine: "GET /hierarchy?fresh=1#x HTTP/1.1"),
            .matched(.cachedHierarchy)
        )
        XCTAssertEqual(
            SdkHierarchyServer.route(forRequestLine: "GET /health#fragment?query HTTP/1.1"),
            .matched(.health)
        )
    }

    func testRequestLineRequiresExactPath() {
        for path in ["/hierarchyX", "/hierarchy/freshX", "/hierarchy/", "/unknown"] {
            XCTAssertEqual(SdkHierarchyServer.route(forRequestLine: "GET \(path) HTTP/1.1"), .notFound, path)
        }
    }

    func testRequestLineReportsAllowedMethod() {
        let requests = [("POST /health", "GET"), ("GET /db/execute", "POST"), ("POST /hierarchy", "GET")]
        for (request, method) in requests {
            XCTAssertEqual(
                SdkHierarchyServer.route(forRequestLine: "\(request) HTTP/1.1"),
                .methodNotAllowed(allowed: [method]), request
            )
        }
    }

    func testMalformedRequestLines() {
        for request in [
            "",
            "GET",
            "GET /health",
            "GET /health HTTP/1.1 extra",
            "GET health HTTP/1.1",
            "GET  /health HTTP/1.1",
            " GET /health HTTP/1.1",
            "GET /health ",
        ] {
            XCTAssertEqual(SdkHierarchyServer.route(forRequestLine: request), .malformed, request)
        }
    }

    func testHealthQueryCannotSelectFreshHierarchy() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let response = try roundTrip(
                port: port, head: "GET /health?x=GET%20/hierarchy/fresh HTTP/1.1\r\nHost: localhost\r\n\r\n", body: ""
            )
            try assertHealthResponse(response)
        }
    }

    func testHealthIgnoresRouteTextInHeadersAndBody() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let payload = "GET /hierarchy/fresh POST /db/execute"
            let response = try roundTrip(
                port: port,
                head: "GET /health HTTP/1.1\r\nX-Note: POST /db/execute GET /hierarchy/fresh\r\n"
                    + "Content-Length: \(payload.utf8.count)\r\n\r\n",
                body: payload
            )
            try assertHealthResponse(response)
        }
    }

    func testHierarchySuffixReturnsNotFound() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let response = try roundTrip(port: port, head: "GET /hierarchyX HTTP/1.1\r\n\r\n", body: "")
            assertErrorResponse(response, status: "404 Not Found", error: "not_found")
        }
    }

    func testHealthWrongMethodReturnsAllowHeader() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let response = try roundTrip(port: port, head: "POST /health HTTP/1.1\r\n\r\n", body: "")
            assertErrorResponse(response, status: "405 Method Not Allowed", error: "method_not_allowed")
            XCTAssertTrue(response.contains("\r\nAllow: GET\r\n"), response)
        }
    }

    func testDatabaseWrongMethodReturnsAllowHeader() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let response = try roundTrip(port: port, head: "GET /db/execute HTTP/1.1\r\n\r\n", body: "")
            assertErrorResponse(response, status: "405 Method Not Allowed", error: "method_not_allowed")
            XCTAssertTrue(response.contains("\r\nAllow: POST\r\n"), response)
        }
    }

    func testMalformedRequestLineReturnsBadRequest() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let response = try roundTrip(port: port, head: "GET /health HTTP/1.1 extra\r\n\r\n", body: "")
            assertErrorResponse(response, status: "400 Bad Request", error: "bad_request")
        }
    }

    func testOversizedUnterminatedHeaderClosesWith431() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let head = "GET /health HTTP/1.1\r\nX-Pad: " +
                String(repeating: "x", count: SdkHierarchyServer.maxHeaderBytes + 4096)
            let response = try roundTrip(port: port, head: head, body: "")
            assertErrorResponse(
                response,
                status: "431 Request Header Fields Too Large",
                error: "request_header_fields_too_large"
            )
        }
    }

    func testOversizedFragmentedHeaderClosesWith431() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            // roundTrip sends these in separate writes without closing the client write side.
            let head = "GET /health HTTP/1.1\r\nX-Pad: " + String(repeating: "x", count: 8192)
            let tail = String(repeating: "x", count: SdkHierarchyServer.maxHeaderBytes)
            let response = try roundTrip(port: port, head: head, body: tail)
            assertErrorResponse(
                response,
                status: "431 Request Header Fields Too Large",
                error: "request_header_fields_too_large"
            )
        }
    }

    func testOversizedTerminatedHeaderClosesWith431() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let head = "GET /health HTTP/1.1\r\nX-Pad: "
                + String(repeating: "x", count: SdkHierarchyServer.maxHeaderBytes + 4096) + "\r\n\r\n"
            let response = try roundTrip(port: port, head: head, body: "")
            assertErrorResponse(
                response,
                status: "431 Request Header Fields Too Large",
                error: "request_header_fields_too_large"
            )
        }
    }

    func testHeaderExactlyAtLimitRoutesNormally() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let prefix = "GET /health HTTP/1.1\r\nX-Pad: "
            let header = prefix + String(repeating: "x", count: SdkHierarchyServer.maxHeaderBytes - prefix.utf8.count)
            XCTAssertEqual(header.utf8.count, SdkHierarchyServer.maxHeaderBytes)
            let response = try roundTrip(port: port, head: header + "\r\n\r\n", body: "")
            try assertHealthResponse(response)
        }
    }

    func testBelowLimitHeaderWithLargeBodyRoutesNormally() throws {
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let prefix = "GET /health HTTP/1.1\r\nContent-Length: 32768\r\nX-Pad: "
            let header = prefix + String(
                repeating: "x",
                count: SdkHierarchyServer.maxHeaderBytes - 16 - prefix.utf8.count
            )
            let response = try roundTrip(
                port: port,
                head: header + "\r\n\r\n" + String(repeating: "x", count: 32768), body: ""
            )
            try assertHealthResponse(response)
        }
    }

    func testRoutingErrorsRetainForegroundGate() throws {
        try withRunningServer(tracker: FakeHierarchyTracker(isApplicationActive: false)) { port in
            let response = try roundTrip(port: port, head: "POST /unknown HTTP/1.1 extra\r\n\r\n", body: "")
            assertErrorResponse(response, status: "409 Conflict", error: "app_not_active")
        }
    }

    private struct HealthStatus: Decodable {
        let status: String
    }

    func testWrongMethodRetainsForegroundGate() throws {
        try withRunningServer(tracker: FakeHierarchyTracker(isApplicationActive: false)) { port in
            let response = try roundTrip(port: port, head: "POST /health HTTP/1.1\r\n\r\n", body: "")
            assertErrorResponse(response, status: "409 Conflict", error: "app_not_active")
        }
    }

    func testIdentityGatePrecedesForegroundAndMalformedRouting() throws {
        let udid = "ABCDEF00-1234-4567-89AB-000000000001"
        let tracker = FakeHierarchyTracker(isApplicationActive: false)
        let identity = SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid])
        try withRunningServer(tracker: tracker, identity: identity) { port in
            let response = try roundTrip(
                port: port,
                head: "POST /health HTTP/1.1 extra\r\nX-AutoMobile-Simulator-Udid: wrong\r\n\r\n", body: ""
            )
            XCTAssertTrue(response.hasPrefix("HTTP/1.1 409 Conflict"), response)
            let body = try XCTUnwrap(response.components(separatedBy: "\r\n\r\n").last)
            let payload = try JSONDecoder().decode([String: String].self, from: Data(body.utf8))
            XCTAssertEqual(payload, ["error": "wrong_simulator", "expectedUdid": udid, "actualUdid": "wrong"])
        }
    }

    private func assertHealthResponse(_ response: String) throws {
        XCTAssertTrue(response.hasPrefix("HTTP/1.1 200 OK"), response)
        let body = try XCTUnwrap(response.components(separatedBy: "\r\n\r\n").last)
        let payload = try JSONDecoder().decode(HealthStatus.self, from: Data(body.utf8))
        XCTAssertEqual(payload.status, "ok")
    }

    private func assertErrorResponse(_ response: String, status: String, error: String) {
        XCTAssertTrue(response.hasPrefix("HTTP/1.1 \(status)"), response)
        XCTAssertEqual(response.components(separatedBy: "\r\n\r\n").last, "{\"error\":\"\(error)\"}")
    }

    private final class FakeHierarchyTracker: SdkHierarchyServing {
        var bundleId: String? {
            "test.bundle"
        }

        let isApplicationActive: Bool

        init(isApplicationActive: Bool = true) {
            self.isApplicationActive = isApplicationActive
        }

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
            lifecycleLock: lifecycleLock,
            identity: SdkSimulatorIdentity(environment: [:])
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
        identity: SdkSimulatorIdentity = SdkSimulatorIdentity(environment: [:]),
        _ body: (NWEndpoint.Port) throws -> Void
    )
        throws
    {
        let listener = try LoopbackListener()
        let server = SdkHierarchyServer(
            tracker: tracker, identity: identity,
            portListenerFactory: { port in
                // This helper owns one ephemeral listener; skip the simulator's legacy listener.
                if identity.udid != nil, port == SdkHierarchyServer.port {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(EADDRINUSE))
                }
                return listener
            }
        )
        server.start()
        defer { server.stop() }

        XCTAssertEqual(listener.didBecomeReady.wait(timeout: .now() + 5), .success, "listener should bind")
        guard let port = listener.boundPort else {
            XCTFail("listener reported no bound port")
            return
        }
        try body(port)
    }

    func testBackgroundSimulatorHealthRejectsEvenMatchingIdentity() throws {
        let udid = "ABCDEF00-1234-4567-89AB-000000000001"
        let tracker = FakeHierarchyTracker(isApplicationActive: false)
        let identity = SdkSimulatorIdentity(environment: ["SIMULATOR_UDID": udid])
        try withRunningServer(tracker: tracker, identity: identity) { port in
            let response = try roundTrip(
                port: port,
                head: "GET /health HTTP/1.1\r\nHost: localhost\r\nX-AutoMobile-Simulator-Udid: \(udid)\r\n\r\n",
                body: ""
            )
            XCTAssertTrue(response.hasPrefix("HTTP/1.1 409 Conflict"), "expected a 409, got: \(response)")
            let body = try XCTUnwrap(response.components(separatedBy: "\r\n\r\n").last)
            XCTAssertEqual(body, "{\"error\":\"app_not_active\"}")
            let payload = try JSONDecoder().decode([String: String].self, from: Data(body.utf8))
            XCTAssertEqual(payload, ["error": "app_not_active"])
        }
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

    // MARK: - Storage routes run off the accept queue (#10166)

    /// Database driver whose `executeSQL` waits for `release()`, standing in for a statement blocked on
    /// the app's write lock. Records the order statements started in.
    private final class BlockingDatabaseDriver: DatabaseDriver, @unchecked Sendable {
        static let blockingQuery = "SELECT 'blocking'"
        let path: String
        let entered = DispatchSemaphore(value: 0)
        private let gate = DispatchSemaphore(value: 0)
        private let stateLock = NSLock()
        private var started: [String] = []

        init(path: String) {
            self.path = path
        }

        var startedQueries: [String] {
            stateLock.lock()
            defer { stateLock.unlock() }
            return started
        }

        func release() {
            gate.signal()
        }

        func getDatabases() -> [DatabaseDescriptor] {
            [DatabaseDescriptor(name: "blocking.db", path: path, sizeBytes: 0)]
        }

        func getTables(databasePath _: String) -> [String] { [] }

        func getTableData(databasePath _: String, table _: String, limit _: Int, offset _: Int) -> TableDataResult {
            TableDataResult(columns: [], rows: [], totalRows: 0)
        }

        func getTableStructure(databasePath _: String, table _: String) -> TableStructureResult {
            TableStructureResult(columns: [])
        }

        func executeSQL(databasePath _: String, query: String) -> SQLExecutionResult {
            stateLock.lock()
            started.append(query)
            stateLock.unlock()
            if query == Self.blockingQuery {
                entered.signal()
                _ = gate.wait(timeout: .now() + 10)
            }
            return SQLExecutionResult(columns: ["v"], rows: [[query]], rowsAffected: 0)
        }
    }

    private func installBlockingDriver() -> BlockingDatabaseDriver {
        let driver = BlockingDatabaseDriver(path: "/tmp/blocking.db")
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(driver)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(allowedDatabasePaths: [driver.path]))
        DatabaseInspector.shared.setEnabled(true)
        return driver
    }

    private func executeRequest(path: String, query: String) -> (head: String, body: String) {
        let body = "{\"databasePath\":\"\(path)\",\"query\":\"\(query)\"}"
        let head = "POST /db/execute HTTP/1.1\r\nHost: localhost\r\nContent-Length: \(body.utf8.count)\r\n\r\n"
        return (head, body)
    }

    /// Sends a request and returns immediately; the caller cancels the connection.
    private func sendWithoutWaiting(port: NWEndpoint.Port, head: String, body: String) -> NWConnection {
        let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        connection.stateUpdateHandler = { state in
            guard case .ready = state else { return }
            connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in })
        }
        connection.start(queue: DispatchQueue(label: "sdk-hierarchy-server-test-pending-client"))
        return connection
    }

    func testBlockedDatabaseRequestDoesNotStopHealthFromAnswering() throws {
        let driver = installBlockingDriver()
        defer {
            driver.release()
            DatabaseInspector.shared.reset()
        }
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let request = executeRequest(path: driver.path, query: BlockingDatabaseDriver.blockingQuery)
            let pending = sendWithoutWaiting(port: port, head: request.head, body: request.body)
            defer { pending.cancel() }
            XCTAssertEqual(driver.entered.wait(timeout: .now() + 5), .success, "the statement should be running")

            let health = try roundTrip(
                port: port, head: "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n", body: ""
            )
            try assertHealthResponse(health)
            driver.release()
        }
    }

    func testDatabaseRequestsStillRunInArrivalOrder() throws {
        let driver = installBlockingDriver()
        defer {
            driver.release()
            DatabaseInspector.shared.reset()
        }
        try withRunningServer(tracker: FakeHierarchyTracker()) { port in
            let first = executeRequest(path: driver.path, query: BlockingDatabaseDriver.blockingQuery)
            let pending = sendWithoutWaiting(port: port, head: first.head, body: first.body)
            defer { pending.cancel() }
            XCTAssertEqual(driver.entered.wait(timeout: .now() + 5), .success)

            let second = executeRequest(path: driver.path, query: "SELECT 2")
            let secondPending = sendWithoutWaiting(port: port, head: second.head, body: second.body)
            defer { secondPending.cancel() }
            // The second statement queues behind the blocked first one on the storage queue.
            Thread.sleep(forTimeInterval: 0.1)
            XCTAssertEqual(driver.startedQueries, [BlockingDatabaseDriver.blockingQuery])

            driver.release()
            let deadline = Date().addingTimeInterval(5)
            while driver.startedQueries.count < 2, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            XCTAssertEqual(driver.startedQueries, [BlockingDatabaseDriver.blockingQuery, "SELECT 2"])
        }
    }
}
