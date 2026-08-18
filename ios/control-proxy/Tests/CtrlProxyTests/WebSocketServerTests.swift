@testable import CtrlProxy
import XCTest

/// Locks the decode-failure → error-response path #2854 moved *out* of
/// `CommandHandler.handle` and *into* `WebSocketServer.handleMessage`'s `catch`
/// (WebSocketServer.swift): a command that fails to decode is caught,
/// `extractRequestId(from:)` recovers the correlation id from the raw JSON, and
/// `sendErrorResponse` → `buildErrorResponseData` renders the wire envelope
/// (issue #2859 part 4). That path was previously asserted only by a comment.
///
/// These tests drive the **real** `handleMessage` (via the `WebSocketResponding`
/// seam and a capturing fake connection), so a regression in the catch-block
/// wiring itself — e.g. dropping `extractRequestId` or the `sendErrorResponse`
/// hop — fails here, not just a regression in the helpers it composes.
final class WebSocketServerTests: XCTestCase {
    /// Captures every framed message the server would put on the wire.
    private final class FakeResponder: WebSocketResponding {
        private(set) var sent: [Data] = []
        func send(_ data: Data) {
            sent.append(data)
        }
    }

    /// Thread-safe responder for the command-offload test: `dispatchCommand`
    /// delivers `send` from the `commandQueue`, so the test thread reads `count`
    /// concurrently and must not race a bare array append.
    private final class LockingResponder: WebSocketResponding {
        private let lock = NSLock()
        private var _sent: [Data] = []
        /// Invoked on every `send`, on whatever queue produced the response.
        var onSend: ((Data) -> Void)?
        var count: Int {
            lock.lock()
            defer { lock.unlock() }
            return _sent.count
        }

        func send(_ data: Data) {
            lock.lock()
            _sent.append(data)
            lock.unlock()
            onSend?(data)
        }
    }

    private final class TransitionInjectingExecutor: FrameContextMainExecuting {
        var afterNextPerform: (() -> Void)?

        func perform<T>(_ operation: () throws -> T) throws -> T {
            let result = try operation()
            let callback = afterNextPerform
            afterNextPerform = nil
            callback?()
            return result
        }
    }

    private var perfProvider: PerfProvider!

    override func tearDown() {
        perfProvider?.clear()
        PerfProvider.resetInstance()
        super.tearDown()
    }

    /// A `WebSocketServer` wired to fakes, with a test perf provider so the
    /// singleton is untouched.
    private func makeServer(
        frameContext: FrameContext = FrameContext(),
        broadcastSink: ((Data) -> Void)? = nil,
        elementLocator: ElementLocating = FakeElementLocator()
    )
        -> WebSocketServer
    {
        let fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        let handler = CommandHandler.createForTesting(
            elementLocator: elementLocator,
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: perfProvider
        )
        return WebSocketServer(
            port: 8765,
            commandHandler: handler,
            perfProvider: perfProvider,
            sdkHierarchyCache: nil,
            frameContext: frameContext,
            broadcastSink: broadcastSink
        )
    }

    /// Drive a raw command through the real `handleMessage` and return the single
    /// framed message the server emitted, decoded as a JSON object.
    private func handle(
        rawCommand json: String,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> [String: Any]
    {
        let responder = FakeResponder()
        makeServer().handleMessage(Data(json.utf8), responder: responder)
        guard responder.sent.count == 1 else {
            XCTFail("expected exactly one framed response, got \(responder.sent.count)", file: file, line: line)
            return [:]
        }
        guard let object = try? JSONSerialization.jsonObject(with: responder.sent[0]) as? [String: Any] else {
            XCTFail("response was not a valid JSON object", file: file, line: line)
            return [:]
        }
        return object
    }

    private func assertErrorEnvelope(
        _ envelope: [String: Any],
        requestId expectedRequestId: String?,
        errorContains needle: String,
        file: StaticString = #file,
        line: UInt = #line
    ) {
        XCTAssertEqual(envelope["type"] as? String, "error", "envelope type", file: file, line: line)
        XCTAssertEqual(envelope["success"] as? Bool, false, "envelope success", file: file, line: line)
        if let expectedRequestId = expectedRequestId {
            XCTAssertEqual(
                envelope["requestId"] as? String,
                expectedRequestId,
                "requestId preserved from raw JSON",
                file: file,
                line: line
            )
        } else {
            XCTAssertNil(envelope["requestId"] as? String, "requestId should be absent/null", file: file, line: line)
        }
        let message = (envelope["error"] as? String) ?? ""
        XCTAssertTrue(
            message.contains(needle),
            "error text should contain \"\(needle)\", got: \(message)",
            file: file,
            line: line
        )
    }

    func testBroadcastHierarchyUpdateRetainsCapturedTransitionContext() throws {
        let screenA = ViewHierarchy(
            packageName: "com.example.app",
            hierarchy: UIElementInfo(text: "A")
        )
        let screenB = ViewHierarchy(
            packageName: "com.example.app",
            hierarchy: UIElementInfo(text: "B")
        )
        let epoch = UUID()
        let expectedContext = FrameContext(epoch: epoch).recordTransition(to: screenA)
        let executor = TransitionInjectingExecutor()
        let frameContext = FrameContext(epoch: epoch, mainThreadExecutor: executor)
        var broadcasts: [Data] = []
        let server = makeServer(
            frameContext: frameContext,
            broadcastSink: { broadcasts.append($0) }
        )

        executor.afterNextPerform = {
            frameContext.recordTransition(to: screenB)
            frameContext.recordTransition(to: screenA)
        }

        server.broadcastHierarchyUpdate(screenA)

        XCTAssertEqual(broadcasts.count, 1)
        let response = try JSONDecoder().decode(HierarchyUpdateResponse.self, from: broadcasts[0])
        XCTAssertEqual(response.frameContext, expectedContext)
        XCTAssertNotEqual(response.frameContext, frameContext.context(for: screenA))
    }

    // MARK: - Decode-failure → error envelope (real handleMessage path)

    /// An unknown command `type` (no enum case) is rejected at decode; the real
    /// catch path yields a `type:"error"`, `success:false` envelope that preserves
    /// the requestId and carries the exact "Unknown command type: <type>" wire text
    /// the TS `rewriteUnknownCommandError` matches.
    func testUnknownCommandTypeYieldsErrorEnvelopePreservingRequestId() {
        let envelope = handle(rawCommand: #"{"type":"totally_unknown","requestId":"uc-99"}"#)
        assertErrorEnvelope(envelope, requestId: "uc-99", errorContains: "Unknown command type: totally_unknown")
    }

    /// A missing required field (here `x` on `request_tap_coordinates`) is rejected
    /// at decode; the catch path still produces the structured error envelope with
    /// the requestId preserved and a non-empty error text. (The keyNotFound wire
    /// text itself is pinned byte-for-byte in `TypedRequestDecodeTests` / #2965.)
    func testMissingRequiredFieldYieldsErrorEnvelopePreservingRequestId() {
        let envelope = handle(rawCommand: #"{"type":"request_tap_coordinates","requestId":"mf-1","y":2}"#)
        XCTAssertEqual(envelope["type"] as? String, "error")
        XCTAssertEqual(envelope["success"] as? Bool, false)
        XCTAssertEqual(envelope["requestId"] as? String, "mf-1")
        XCTAssertFalse((envelope["error"] as? String ?? "").isEmpty, "error text must be present")
    }

    /// When the raw JSON carries no requestId, the error envelope's requestId is
    /// null rather than fabricated.
    func testErrorEnvelopeHasNullRequestIdWhenAbsent() {
        let envelope = handle(rawCommand: #"{"type":"totally_unknown"}"#)
        assertErrorEnvelope(envelope, requestId: nil, errorContains: "Unknown command type")
    }

    /// The success path is exercised through the same real `handleMessage`: a valid
    /// command dispatches and its typed result is framed and sent (proving the seam
    /// carries the normal path too, not only the catch).
    func testValidCommandDispatchesAndSendsTypedResult() {
        let envelope = handle(rawCommand: #"{"type":"request_press_back","requestId":"pb-1"}"#)
        XCTAssertEqual(envelope["type"] as? String, "press_back_result")
        XCTAssertEqual(envelope["success"] as? Bool, true)
        XCTAssertEqual(envelope["requestId"] as? String, "pb-1")
    }

    // MARK: - extractRequestId (raw-JSON correlation-id recovery)

    func testExtractRequestIdReadsRequestIdFromRawJson() {
        let id = WebSocketServer.extractRequestId(from: Data(#"{"type":"x","requestId":"abc"}"#.utf8))
        XCTAssertEqual(id, "abc")
    }

    func testExtractRequestIdReturnsNilWhenRequestIdMissing() {
        let id = WebSocketServer.extractRequestId(from: Data(#"{"type":"x"}"#.utf8))
        XCTAssertNil(id)
    }

    /// A non-string requestId (e.g. a number) is not coerced — the correlation id
    /// contract is string-only, so extraction returns nil rather than a stringified
    /// number.
    func testExtractRequestIdReturnsNilForNonStringRequestId() {
        let id = WebSocketServer.extractRequestId(from: Data(#"{"type":"x","requestId":42}"#.utf8))
        XCTAssertNil(id)
    }

    func testExtractRequestIdReturnsNilForMalformedJson() {
        let id = WebSocketServer.extractRequestId(from: Data(#"{"type":"x","requestId":}"#.utf8))
        XCTAssertNil(id)
    }

    // MARK: - ConnectionRegistry thread safety (#3611)

    /// Basic set/get/remove/count/snapshot semantics.
    func testConnectionRegistryBasicOperations() {
        let registry = ConnectionRegistry<String>()
        XCTAssertEqual(registry.count, 0)
        XCTAssertNil(registry.value(forId: 1))

        registry.set("a", forId: 1)
        registry.set("b", forId: 2)
        XCTAssertEqual(registry.count, 2)
        XCTAssertEqual(registry.value(forId: 1), "a")
        XCTAssertEqual(Set(registry.values()), ["a", "b"])

        registry.removeValue(forId: 1)
        XCTAssertNil(registry.value(forId: 1))
        XCTAssertEqual(registry.count, 1)

        let removed = registry.removeAll()
        XCTAssertEqual(removed, ["b"])
        XCTAssertEqual(registry.count, 0)
    }

    /// Hammer the registry from many threads while snapshotting concurrently —
    /// mirrors the real hazard where connect/disconnect on the server queue races
    /// broadcast iteration on the main thread. Under the pre-fix code (a bare
    /// `Dictionary` mutated while `Array(storage.values)` is read) this trips the
    /// Swift runtime / corrupts; with the lock it completes cleanly. The assertion
    /// is that it does not crash and ends empty after a balanced add/remove.
    func testConnectionRegistryConcurrentAccessDoesNotCrash() {
        let registry = ConnectionRegistry<Int>()
        let iterations = 2_000

        DispatchQueue.concurrentPerform(iterations: iterations) { i in
            registry.set(i, forId: i)
            _ = registry.values()   // snapshot iteration, concurrent with mutation
            _ = registry.count
            registry.removeValue(forId: i)
        }

        // Every id added was also removed, so the registry must be empty and intact.
        XCTAssertEqual(registry.count, 0)
        XCTAssertTrue(registry.values().isEmpty)
    }

    // MARK: - Command offload keeps the server queue responsive (#5374)

    /// A slow command (element-tree walk / screenshot / semaphore-blocked SDK
    /// call) used to run inline on the server `DispatchQueue`, which also accepts
    /// connections and answers `GET /health` and `POST /sdk-events`. While it ran,
    /// those were starved — a live-but-unresponsive runner whose `/health` probes
    /// time out mid-run (issue #5374: XCTestRunner Simulator Tests, five 5s health
    /// probes returning 0 bytes).
    ///
    /// `dispatchCommand` now offloads execution onto a dedicated serial
    /// `commandQueue`, so the caller (the server queue) returns immediately and
    /// stays free to serve `/health`. This drives the real offload path with a
    /// blocking `getViewHierarchy` and asserts the caller is not blocked while the
    /// command runs. Pre-fix (inline execution) the caller blocks for the full
    /// release delay and the elapsed-time assertion fails; the response still
    /// arrives once the handler is released, proving the offload preserves it.
    func testDispatchCommandDoesNotBlockCallerWhileHandlerRuns() {
        let releaseAfter: TimeInterval = 0.5
        let handlerReleased = DispatchSemaphore(value: 0)
        let handlerEntered = DispatchSemaphore(value: 0)

        let locator = FakeElementLocator()
        locator.onHierarchyRead = {
            // Signal that the command is executing, then block until released.
            handlerEntered.signal()
            _ = handlerReleased.wait(timeout: .now() + 10)
        }

        let server = makeServer(elementLocator: locator)
        let responder = LockingResponder()
        let responded = expectation(description: "command response delivered after handler release")
        responder.onSend = { _ in responded.fulfill() }

        // Independent releaser: unblock the handler shortly after it starts, from a
        // thread that is never the caller — so pre-fix the only way the caller can
        // return is by blocking here for `releaseAfter`.
        DispatchQueue.global().async {
            guard handlerEntered.wait(timeout: .now() + 5) == .success else { return }
            Thread.sleep(forTimeInterval: releaseAfter)
            handlerReleased.signal()
        }

        let command = Data(#"{"type":"request_hierarchy","requestId":"offload-1"}"#.utf8)
        let start = Date()
        server.dispatchCommand(command, responder: responder)
        let elapsed = Date().timeIntervalSince(start)

        // Offloaded, the caller returns in microseconds; inline, it blocks for
        // ~releaseAfter until the handler completes. Generous margin for CI jitter.
        XCTAssertLessThan(
            elapsed,
            releaseAfter - 0.1,
            "command execution must be offloaded so the server queue is not blocked (issue #5374)"
        )

        // The response is still produced once the handler is released.
        wait(for: [responded], timeout: 5)
        XCTAssertEqual(responder.count, 1, "exactly one framed response should be delivered")
    }

    // MARK: - WebSocket frame length bounds (#3626)

    func testFrameReadLengthNormalUnmasked() {
        XCTAssertEqual(WebSocketConnection.frameReadLength(payloadLength: 10, isMasked: false), 10)
    }

    func testFrameReadLengthAddsMaskBytes() {
        XCTAssertEqual(WebSocketConnection.frameReadLength(payloadLength: 10, isMasked: true), 14)
    }

    func testFrameReadLengthAtMaxIsAccepted() {
        let max = WebSocketConnection.maxFramePayloadLength
        XCTAssertEqual(WebSocketConnection.frameReadLength(payloadLength: max, isMasked: false), Int(max))
    }

    /// A frame declaring a payload beyond the cap — including one > Int.max that
    /// would trap `Int(length)` in the pre-fix code — is rejected (nil), so the
    /// caller closes the connection instead of crashing the runner (#3626).
    func testFrameReadLengthRejectsOversizedAndOverflowing() {
        let overCap = WebSocketConnection.maxFramePayloadLength + 1
        XCTAssertNil(WebSocketConnection.frameReadLength(payloadLength: overCap, isMasked: false))
        XCTAssertNil(WebSocketConnection.frameReadLength(payloadLength: UInt64(Int.max) + 1, isMasked: false))
        XCTAssertNil(WebSocketConnection.frameReadLength(payloadLength: .max, isMasked: true))
    }

    // MARK: - HTTP request framing

    func testCompleteHTTPRequestLengthWaitsForSplitPostBody() {
        let header = Data("POST /sdk-events HTTP/1.1\r\nContent-Length: 19\r\n\r\n".utf8)
        XCTAssertNil(WebSocketConnection.completeHTTPRequestLength(in: header))

        var completeRequest = header
        completeRequest.append(Data("{\"events\":[],\"x\":1}".utf8))
        XCTAssertEqual(WebSocketConnection.completeHTTPRequestLength(in: completeRequest), completeRequest.count)
    }

    func testCompleteHTTPRequestLengthAcceptsHeaderOnlyHealthRequest() {
        let request = Data("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n".utf8)
        XCTAssertEqual(WebSocketConnection.completeHTTPRequestLength(in: request), request.count)
    }

    // MARK: - /health stays responsive over a real socket while a command blocks (#5374)

    /// A gesture performer whose `pressBack` parks the calling thread on a
    /// semaphore until the test releases it.
    ///
    /// A gesture command runs its operation through `FrameContext.performIfCurrent`
    /// → `runOnMainThread` (`DispatchQueue.main.sync`), so `pressBack` executes on
    /// the **main thread** while the server's dispatch queue is blocked
    /// synchronously waiting for it — reproducing the exact production wedge where
    /// a hung XCUITest gesture pins the runner's main thread.
    private final class BlockingGesturePerformer: FakeGesturePerformer, @unchecked Sendable {
        let didStart = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)

        override func pressBack() throws {
            didStart.signal()
            release.wait()
            try super.pressBack()
        }
    }

    /// Starts a real `WebSocketServer` on the first free port at/above `base`,
    /// returning the running server and its bound port. Bind collisions
    /// (`ServerError.failedToStart`) are retried on the next port so the test
    /// does not depend on a specific port being free.
    private func startServerOnFreePort(
        commandHandler: CommandHandler,
        perfProvider: PerfProvider,
        base: UInt16 = 8850,
        attempts: Int = 40,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> (server: WebSocketServer, port: UInt16)
    {
        for offset in 0 ..< attempts {
            let port = base + UInt16(offset)
            let server = WebSocketServer(
                port: port,
                commandHandler: commandHandler,
                perfProvider: perfProvider
            )
            do {
                try server.start()
                return (server, port)
            } catch {
                continue
            }
        }
        XCTFail("could not bind a WebSocketServer on any port in [\(base), \(base + UInt16(attempts))]", file: file, line: line)
        fatalError("unreachable")
    }

    /// End-to-end regression for the daemon health probe over a real socket:
    /// while one WebSocket connection is stuck inside a blocked command, an
    /// independent `GET /health` request over a *separate* connection must still
    /// return promptly. This is the property the daemon relies on to tell "the
    /// runner is wedged on this gesture" apart from "the runner is dead" — the
    /// XCTestRunner flake in #5374 was exactly this: five 5s `/health` probes
    /// timed out mid-command and a live runner was torn down.
    ///
    /// The command-offload fix (#5374) keeps the server queue free by running
    /// commands on a dedicated `commandQueue`; `testDispatchCommandDoesNotBlock…`
    /// pins that offload at the `dispatchCommand` seam. This test complements it
    /// one layer out — it drives the real `WebSocketServer` (real `NWListener`,
    /// real sockets on 127.0.0.1) and asserts an actual HTTP `GET /health`
    /// returns 200 while a command blocks, covering the accept + HTTP-serving
    /// path the seam-level test does not. The blocked gesture pins the main
    /// thread via `runOnMainThread` (just as a hung XCUITest call does on
    /// device), so the whole probe is orchestrated from a background thread and
    /// the main thread is left free to run the gesture's `main.sync`. It fails —
    /// `/health` never returns 200 — if command execution is ever moved back onto
    /// the queue that accepts connections and serves `/health`.
    func testHealthCheckStaysResponsiveWhileCommandBlocks() throws {
        let fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        let blockingPerformer = BlockingGesturePerformer()
        let handler = CommandHandler.createForTesting(
            elementLocator: FakeElementLocator(),
            gesturePerformer: blockingPerformer,
            perfProvider: perfProvider
        )
        let (server, port) = startServerOnFreePort(commandHandler: handler, perfProvider: perfProvider)
        defer {
            blockingPerformer.release.signal() // unblock the parked command so teardown can proceed
            server.stop()
        }

        // 127.0.0.1 (not "localhost") avoids DNS / IPv6 happy-eyeballs latency.
        let wsURL = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port)/"))
        let healthURL = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/health"))

        let statusBox = Box<Int?>(nil)
        let bodyBox = Box<String?>(nil)
        let probeFinished = expectation(description: "health probe orchestration finished")

        // Everything runs off the main thread: the blocked gesture will occupy
        // the main thread (via runOnMainThread), so the main thread must stay in
        // `wait(for:)` — pumping its run loop — for that `main.sync` to execute.
        DispatchQueue.global().async {
            let session = URLSession(configuration: .ephemeral)
            let wsTask = session.webSocketTask(with: wsURL)
            wsTask.resume()
            wsTask.send(.data(Data(#"{"type":"request_press_back","requestId":"blocker"}"#.utf8))) { _ in }

            // Proceed only once the command is actually executing and thus
            // occupying the main thread + the server's dispatch queue.
            let started = blockingPerformer.didStart.wait(timeout: .now() + 15)

            // With the command parked, GET /health over a separate connection
            // must still respond. Bound by its own timeout so a regression
            // surfaces as a failed assertion, not a hung test.
            let healthConfig = URLSessionConfiguration.ephemeral
            healthConfig.timeoutIntervalForRequest = 4
            let healthSession = URLSession(configuration: healthConfig)
            let healthDone = DispatchSemaphore(value: 0)
            let healthTask = healthSession
                .dataTask(with: healthURL) { data, response, _ in
                    statusBox.value = (response as? HTTPURLResponse)?.statusCode
                    bodyBox.value = data.flatMap { String(data: $0, encoding: .utf8) }
                    healthDone.signal()
                }
            if started == .success {
                healthTask.resume()
                _ = healthDone.wait(timeout: .now() + 6)
            }

            // Unblock the parked gesture so the main thread (and server queue)
            // are released, then hand control back to the main test thread.
            blockingPerformer.release.signal()
            session.invalidateAndCancel()
            healthSession.invalidateAndCancel()
            probeFinished.fulfill()
        }

        wait(for: [probeFinished], timeout: 30)
        XCTAssertEqual(statusBox.value, 200, "health check should return 200 while a command is blocked")
        XCTAssertEqual(
            bodyBox.value.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }?["status"] as? String,
            "ok",
            "health body should report status:ok"
        )
    }
}

/// Reference wrapper so escaping completion handlers can publish a result back
/// to the test without tripping Swift's captured-var concurrency diagnostics.
private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
