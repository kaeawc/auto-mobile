@testable import CtrlProxy
import Network
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
        // The health outcome is captured strictly BEFORE the command is released.
        // In a regression the probe stays blocked until release and only returns
        // afterward; gating on this `.success` (which happens-before the status
        // read) excludes that late response, so a post-release 200 cannot forge a
        // pass. `.timedOut` unless health answers while the command is blocked.
        let healthWaitResult = Box<DispatchTimeoutResult>(.timedOut)
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
                // The completion writes status/body before signaling, so a
                // `.success` here happens-before those reads: the probe answered
                // while the command was still blocked (release not yet signaled).
                healthWaitResult.value = healthDone.wait(timeout: .now() + 6)
            }

            // Only now unblock the parked gesture so the main thread (and server
            // queue) are released, then hand control back to the main test thread.
            blockingPerformer.release.signal()
            session.invalidateAndCancel()
            healthSession.invalidateAndCancel()
            probeFinished.fulfill()
        }

        wait(for: [probeFinished], timeout: 30)
        XCTAssertEqual(
            healthWaitResult.value,
            .success,
            "GET /health must respond while the command is still blocked (before it is released)"
        )
        XCTAssertEqual(statusBox.value, 200, "health check should return 200 while a command is blocked")
        XCTAssertEqual(
            bodyBox.value.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }?["status"] as? String,
            "ok",
            "health body should report status:ok"
        )
    }

    // MARK: - Inbound ping frame handling (#5669)

    /// End-to-end regression over a real socket for the ping-desync bug (#5669):
    /// a client→server ping frame is always masked (RFC 6455 §5.3), so after the
    /// 2-byte header there are 4 masking-key bytes still in the stream. The pre-fix
    /// ping branch sent a pong and immediately read the *next* 2 bytes as a new
    /// frame header — consuming the mask bytes as a bogus header and desyncing the
    /// wire, so every subsequent frame was misparsed. This drives the real
    /// `WebSocketServer` (real `NWListener`, real sockets on 127.0.0.1): it pings,
    /// waits for the pong, then sends a data command. The command's typed response
    /// must still come back — pre-fix it never does because the wire is desynced.
    func testDataFrameAfterPingStillDecodes() throws {
        let fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        let handler = CommandHandler.createForTesting(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: perfProvider
        )
        let (server, port) = startServerOnFreePort(commandHandler: handler, perfProvider: perfProvider)
        defer { server.stop() }

        let wsURL = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port)/"))
        let session = URLSession(configuration: .ephemeral)
        let wsTask = session.webSocketTask(with: wsURL)
        wsTask.resume()
        defer {
            wsTask.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
        }

        // Drain frames until the command response arrives, ignoring the initial
        // `connected` event the server sends on upgrade. The receive loop is
        // started *before* the ping so the task keeps pumping the connection —
        // URLSession only processes an inbound pong (and thus fires `sendPing`'s
        // completion) while a `receive` is outstanding. Pre-fix the wire is
        // desynced after the ping, so this response never decodes and the wait
        // times out.
        let responseReceived = expectation(description: "command response decodes after ping")
        func receiveNext() {
            wsTask.receive { result in
                switch result {
                case let .success(message):
                    let data: Data?
                    switch message {
                    case let .string(text): data = Data(text.utf8)
                    case let .data(bytes): data = bytes
                    @unknown default: data = nil
                    }
                    let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                    if object?["type"] as? String == "press_back_result" {
                        XCTAssertEqual(object?["requestId"] as? String, "after-ping")
                        XCTAssertEqual(object?["success"] as? Bool, true)
                        responseReceived.fulfill()
                    } else {
                        receiveNext()
                    }
                case let .failure(error):
                    // Do not fulfill: a desynced/closed connection surfaces as the
                    // wait timing out, which is the failure this test guards.
                    print("[testDataFrameAfterPingStillDecodes] receive failed: \(error)")
                }
            }
        }
        receiveNext()

        // The client library masks the ping per RFC §5.3. Sending the data command
        // from the pong completion strictly orders it *after* the server has
        // processed the ping — so a surviving desync manifests purely as the
        // command response never coming back.
        wsTask.sendPing { error in
            XCTAssertNil(error, "ping should be answered with a pong")
            wsTask.send(.data(Data(#"{"type":"request_press_back","requestId":"after-ping"}"#.utf8))) { sendError in
                XCTAssertNil(sendError, "sending the data command should not error")
            }
        }
        wait(for: [responseReceived], timeout: 15)
    }

    /// A ping's unmasked application data is routed to a pong (AC2/§5.5.3), while
    /// text/binary frames are delivered and pong/other opcodes are ignored — the
    /// pure decision the socket-facing `readPayload` completion executes.
    func testFrameActionRoutesPingToPongEchoingPayload() {
        let payload = Data("keepalive-42".utf8)
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x09, unmaskedPayload: payload), .pong(payload))
    }

    /// An empty ping yields an empty pong (AC2: empty payload → empty pong).
    func testFrameActionEmptyPingYieldsEmptyPong() {
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x09, unmaskedPayload: Data()), .pong(Data()))
    }

    /// Text (0x01) and binary (0x02) frames are delivered as application messages,
    /// unchanged by the ping fix (AC4).
    func testFrameActionDeliversTextAndBinary() {
        let text = Data("hello".utf8)
        let binary = Data([0x00, 0x01, 0x02])
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x01, unmaskedPayload: text), .deliver(text))
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x02, unmaskedPayload: binary), .deliver(binary))
    }

    /// An inbound pong (0x0A) and any other non-actionable opcode are consumed and
    /// ignored — no pong is echoed back at a pong, so two peers cannot ping-pong
    /// forever (AC4: existing pong handling unchanged).
    func testFrameActionIgnoresPongAndOther() {
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x0A, unmaskedPayload: Data("x".utf8)), .ignore)
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x00, unmaskedPayload: Data()), .ignore)
    }

    /// The pong echo is built as a proper unmasked server frame: FIN|pong opcode,
    /// a 7-bit length, then the payload verbatim (AC2 wire format).
    func testCreateWebSocketFramePongEchoesPayloadOnTheWire() {
        let payload = Data([0x61, 0x62, 0x63]) // "abc"
        let frame = WebSocketConnection.createWebSocketFrame(data: payload, opcode: 0x0A)
        XCTAssertEqual(Array(frame), [0x8A, 0x03, 0x61, 0x62, 0x63])

        let empty = WebSocketConnection.createWebSocketFrame(data: Data(), opcode: 0x0A)
        XCTAssertEqual(Array(empty), [0x8A, 0x00])
    }

    /// Control-frame payload length is bounded at 125 (RFC 6455 §5.5): 125 is the
    /// last accepted value; 126/127 (the extended-length indicators) and anything
    /// larger are rejected, so an over-cap/malformed ping closes the connection
    /// rather than being mis-parsed (AC3).
    func testControlFramePayloadLengthBound() {
        XCTAssertEqual(WebSocketConnection.maxControlFramePayloadLength, 125)
        XCTAssertTrue(WebSocketConnection.isValidControlFramePayloadLength(0))
        XCTAssertTrue(WebSocketConnection.isValidControlFramePayloadLength(125))
        XCTAssertFalse(WebSocketConnection.isValidControlFramePayloadLength(126))
        XCTAssertFalse(WebSocketConnection.isValidControlFramePayloadLength(127))
    }

    // MARK: - Fragmented message reassembly (#5674)

    /// Drives `WebSocketConnection.accumulate` against local reassembly state,
    /// mirroring how one connection feeds successive frames (the helper owns the
    /// `buffer`/`opcode` the production code keeps per-connection). Exposing the
    /// buffer + opcode lets the tests pin both the result *and* the in-place
    /// accumulated bytes / carried opcode.
    private struct FragmentReassembler {
        var buffer = Data()
        var opcode: UInt8?

        mutating func feed(
            opcode: UInt8,
            isFinal: Bool,
            payload: Data,
            maxTotal: UInt64 = WebSocketConnection.maxFramePayloadLength
        )
            -> WebSocketConnection.AccumulateResult
        {
            WebSocketConnection.accumulate(
                into: &buffer,
                opcode: opcode,
                isFinal: isFinal,
                payload: payload,
                inProgressOpcode: &self.opcode,
                maxTotal: maxTotal
            )
        }
    }

    /// AC2: a single unfragmented frame (FIN=1, text/binary opcode, nothing in
    /// progress) is delivered verbatim and leaves no reassembly state behind,
    /// exactly as before the fragmentation fix.
    func testSingleUnfragmentedFrameDeliversUnchanged() {
        var reassembler = FragmentReassembler()
        let payload = Data("hello".utf8)
        XCTAssertEqual(reassembler.feed(opcode: 0x01, isFinal: true, payload: payload), .deliver(payload))
        XCTAssertNil(reassembler.opcode, "a single frame opens no in-progress message")
        XCTAssertTrue(reassembler.buffer.isEmpty, "a single frame is delivered without buffering")
    }

    /// AC1/AC6: a two-fragment message (initial FIN=0 text, final FIN=1
    /// continuation) buffers the first fragment then delivers the ordered
    /// concatenation once complete.
    func testTwoFragmentMessageReassembles() {
        var reassembler = FragmentReassembler()
        let first = Data("Hello, ".utf8)
        let second = Data("world!".utf8)

        XCTAssertEqual(reassembler.feed(opcode: 0x01, isFinal: false, payload: first), .buffered)
        XCTAssertEqual(reassembler.opcode, 0x01)
        XCTAssertEqual(reassembler.buffer, first)

        XCTAssertEqual(reassembler.feed(opcode: 0x00, isFinal: true, payload: second), .deliver(first + second))
        XCTAssertNil(reassembler.opcode, "delivery clears the in-progress opcode")
        XCTAssertTrue(reassembler.buffer.isEmpty, "delivery resets the buffer")
    }

    /// AC1/AC6: a three-fragment binary message (initial FIN=0 binary, a middle
    /// FIN=0 continuation, a final FIN=1 continuation) reassembles in order and
    /// carries the initial opcode forward through each continuation.
    func testThreeFragmentMessageReassemblesInOrder() {
        var reassembler = FragmentReassembler()
        let partA = Data("aaa".utf8)
        let partB = Data("bbb".utf8)
        let partC = Data("ccc".utf8)

        XCTAssertEqual(reassembler.feed(opcode: 0x02, isFinal: false, payload: partA), .buffered)
        XCTAssertEqual(reassembler.opcode, 0x02)
        XCTAssertEqual(reassembler.buffer, partA)

        XCTAssertEqual(reassembler.feed(opcode: 0x00, isFinal: false, payload: partB), .buffered)
        XCTAssertEqual(reassembler.opcode, 0x02, "the initial opcode is carried through continuations")
        XCTAssertEqual(reassembler.buffer, partA + partB)

        XCTAssertEqual(reassembler.feed(opcode: 0x00, isFinal: true, payload: partC), .deliver(partA + partB + partC))
    }

    /// AC2: a non-final data frame does not trigger delivery — it is buffered
    /// with the in-progress opcode recorded.
    func testNonFinalStartFrameDoesNotDeliver() {
        var reassembler = FragmentReassembler()
        let payload = Data("partial".utf8)
        let result = reassembler.feed(opcode: 0x01, isFinal: false, payload: payload)
        XCTAssertEqual(result, .buffered)
        XCTAssertEqual(reassembler.opcode, 0x01)
        XCTAssertEqual(reassembler.buffer, payload)
        if case .deliver = result {
            XCTFail("a non-final frame must not deliver")
        }
    }

    /// AC3: a control frame between fragments is handled independently
    /// (`frameAction` → pong/ignore) and never fed to `accumulate`, so the
    /// in-progress opcode + accumulated buffer are untouched and the following
    /// continuation still reassembles into the full message.
    func testControlFrameBetweenFragmentsDoesNotCorruptReassembly() {
        var reassembler = FragmentReassembler()
        let first = Data("frag-".utf8)
        XCTAssertEqual(reassembler.feed(opcode: 0x01, isFinal: false, payload: first), .buffered)

        // A ping arriving here routes through frameAction, not accumulate, and so
        // does not touch the reassembler's buffer/opcode.
        XCTAssertEqual(WebSocketConnection.frameAction(opcode: 0x09, unmaskedPayload: Data()), .pong(Data()))
        XCTAssertEqual(reassembler.opcode, 0x01)
        XCTAssertEqual(reassembler.buffer, first)

        // The continuation resumes from the unchanged in-progress state.
        let second = Data("done".utf8)
        XCTAssertEqual(reassembler.feed(opcode: 0x00, isFinal: true, payload: second), .deliver(first + second))
    }

    /// AC5/AC6: a continuation frame with no message in progress is a protocol
    /// error, so the caller closes the connection rather than mis-delivering.
    func testContinuationWithNoMessageInProgressIsRejected() {
        var reassembler = FragmentReassembler()
        let result = reassembler.feed(opcode: 0x00, isFinal: true, payload: Data("x".utf8))
        guard case .protocolError = result else {
            return XCTFail("a continuation with no in-progress message must be a protocol error")
        }
    }

    /// AC5: a new non-control data frame while a fragmented message is still open
    /// is a protocol error (interleaved data messages are not permitted, §5.4).
    func testNewDataFrameWhileFragmentOpenIsRejected() {
        var reassembler = FragmentReassembler()
        XCTAssertEqual(reassembler.feed(opcode: 0x01, isFinal: false, payload: Data("open".utf8)), .buffered)
        let result = reassembler.feed(opcode: 0x01, isFinal: false, payload: Data("y".utf8))
        guard case .protocolError = result else {
            return XCTFail("a new data frame during an open fragment must be a protocol error")
        }
    }

    /// AC4: reassembly is bounded by the total accumulated size — a continuation
    /// that would push the message past `maxTotal` is a protocol error rather than
    /// growing the buffer unboundedly.
    func testReassemblyTotalSizeBoundExceededIsRejected() {
        var reassembler = FragmentReassembler()
        XCTAssertEqual(
            reassembler.feed(opcode: 0x01, isFinal: false, payload: Data("hello".utf8), maxTotal: 8), // 5
            .buffered
        )
        let result = reassembler.feed(opcode: 0x00, isFinal: true, payload: Data("world".utf8), maxTotal: 8) // +5 → 10 > 8
        guard case .protocolError = result else {
            return XCTFail("exceeding the total reassembled size bound must be a protocol error")
        }
    }

    /// AC4: a message whose total lands exactly on the bound is accepted — the
    /// cap is inclusive, matching `frameReadLength`'s per-frame bound.
    func testReassemblyAtExactBoundIsAccepted() {
        var reassembler = FragmentReassembler()
        XCTAssertEqual(
            reassembler.feed(opcode: 0x01, isFinal: false, payload: Data("hel".utf8), maxTotal: 5), // 3
            .buffered
        )
        XCTAssertEqual(
            reassembler.feed(opcode: 0x00, isFinal: true, payload: Data("lo".utf8), maxTotal: 5), // +2 → 5 == 5
            .deliver(Data("hello".utf8))
        )
    }

    /// AC4/AC5: malformed or over-budget data/continuation frames are rejected
    /// from the header, *before* the payload is received/unmasked, so a malformed
    /// peer cannot make the runner allocate a frame it will immediately discard.
    /// This mirrors `accumulate`'s rejections but pre-read, and covers every
    /// admissible/inadmissible header combination.
    func testPreReadDataFrameDecisionRejectsBeforeAllocating() {
        typealias Decision = WebSocketConnection.FramePreReadDecision
        let max = WebSocketConnection.maxFramePayloadLength

        // Admissible: a fresh single/opening data frame within the cap.
        XCTAssertEqual(
            WebSocketConnection.preReadDataFrameDecision(opcode: 0x01, declaredPayloadLength: 100, inProgressOpcode: nil, alreadyBuffered: 0),
            Decision.read
        )
        // Admissible: a continuation that fits the remaining budget exactly.
        XCTAssertEqual(
            WebSocketConnection.preReadDataFrameDecision(opcode: 0x00, declaredPayloadLength: 4, inProgressOpcode: 0x01, alreadyBuffered: 6, maxTotal: 10),
            Decision.read
        )

        // The Codex vector: a new data frame declared while a fragment is open —
        // illegal, and must be rejected before its ~64 MiB payload is read.
        guard case .reject = WebSocketConnection.preReadDataFrameDecision(opcode: 0x02, declaredPayloadLength: max, inProgressOpcode: 0x01, alreadyBuffered: Int(max)) else {
            return XCTFail("a new data frame while a fragment is open must be rejected pre-read")
        }
        // A continuation that would overflow the total budget — rejected pre-read.
        guard case .reject = WebSocketConnection.preReadDataFrameDecision(opcode: 0x00, declaredPayloadLength: 5, inProgressOpcode: 0x01, alreadyBuffered: 6, maxTotal: 10) else {
            return XCTFail("an over-budget continuation must be rejected pre-read")
        }
        // A continuation with no message in progress — rejected pre-read.
        guard case .reject = WebSocketConnection.preReadDataFrameDecision(opcode: 0x00, declaredPayloadLength: 1, inProgressOpcode: nil, alreadyBuffered: 0) else {
            return XCTFail("an orphan continuation must be rejected pre-read")
        }
        // A single data frame larger than the whole cap — rejected pre-read.
        guard case .reject = WebSocketConnection.preReadDataFrameDecision(opcode: 0x01, declaredPayloadLength: max + 1, inProgressOpcode: nil, alreadyBuffered: 0) else {
            return XCTFail("an over-cap opening frame must be rejected pre-read")
        }
    }

    /// AC1/AC2/AC3 end-to-end over a real socket: a client command split across
    /// two masked WebSocket fragments — with a ping interleaved between them — is
    /// reassembled by the server and dispatched, so its typed response still comes
    /// back. Pre-fix the first fragment alone is not valid JSON (or is dropped) and
    /// the continuation payload is discarded, so no `press_back_result` arrives and
    /// the wait times out.
    func testFragmentedCommandReassemblesEndToEnd() throws {
        let fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        let handler = CommandHandler.createForTesting(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: perfProvider
        )
        let (server, port) = startServerOnFreePort(commandHandler: handler, perfProvider: perfProvider)
        defer { server.stop() }

        let client = RawWebSocketClient(port: port)
        defer { client.close() }
        try client.connectAndUpgrade(timeout: 10)

        let command = #"{"type":"request_press_back","requestId":"frag-1"}"#
        let bytes = Array(command.utf8)
        let mid = bytes.count / 2
        let first = Data(bytes[0 ..< mid])
        let second = Data(bytes[mid ..< bytes.count])

        // Initial text fragment (FIN=0, opcode 0x1), an interleaved ping (a
        // control frame, FIN=1, opcode 0x9), then the final continuation
        // (FIN=1, opcode 0x0).
        client.sendFrame(opcode: 0x01, fin: false, payload: first)
        client.sendFrame(opcode: 0x09, fin: true, payload: Data("ka".utf8))
        client.sendFrame(opcode: 0x00, fin: true, payload: second)

        // The command dispatches through `runOnMainThread` (`DispatchQueue.main.sync`),
        // so the main thread must stay in `wait(for:)` pumping its run loop for the
        // response to be produced — the frame polling therefore runs on a background
        // queue and reports back via the expectation (mirroring the ping test).
        let responseBox = Box<[String: Any]?>(nil)
        let received = expectation(description: "fragmented command response decodes")
        DispatchQueue.global().async {
            let object = try? client.waitForMessage(timeout: 12) { object in
                object["type"] as? String == "press_back_result"
            }
            responseBox.value = object
            received.fulfill()
        }
        wait(for: [received], timeout: 15)

        let response = try XCTUnwrap(responseBox.value, "expected a press_back_result response")
        XCTAssertEqual(response["requestId"] as? String, "frag-1")
        XCTAssertEqual(response["success"] as? Bool, true)
    }

    // MARK: - Client presence gating (#5477)

    /// Presence tracks only upgraded WebSocket clients and fires the hook exactly
    /// on the zero <-> non-zero transitions, so the device samplers can start on
    /// the first client and stop on the last disconnect.
    func testClientPresenceTogglesOnFirstAndLastClient() {
        let server = makeServer()
        let events = Box<[Bool]>([])
        server.onClientPresenceChanged = { events.value.append($0) }

        XCTAssertFalse(server.hasConnectedClients, "no clients at start")

        server.clientDidUpgrade(1)
        XCTAssertTrue(server.hasConnectedClients)
        XCTAssertEqual(events.value, [true], "first client fires presence=true")

        // A second client is already-present; presence must not re-fire.
        server.clientDidUpgrade(2)
        XCTAssertEqual(events.value, [true], "second client does not re-fire")
        XCTAssertTrue(server.hasConnectedClients)

        // One of two disconnecting keeps presence.
        server.clientDidDisconnect(1)
        XCTAssertEqual(events.value, [true], "one remaining client keeps presence")
        XCTAssertTrue(server.hasConnectedClients)

        // The last disconnect fires presence=false.
        server.clientDidDisconnect(2)
        XCTAssertEqual(events.value, [true, false], "last disconnect fires presence=false")
        XCTAssertFalse(server.hasConnectedClients)
    }

    /// A transient HTTP connection (`GET /health`, `POST /sdk-events`) never
    /// upgrades, so its close must not toggle presence — otherwise health probes
    /// would thrash the samplers on and off.
    func testHttpOnlyConnectionCloseDoesNotTogglePresence() {
        let server = makeServer()
        let events = Box<[Bool]>([])
        server.onClientPresenceChanged = { events.value.append($0) }

        // An id that never upgraded closes; no transition should be reported.
        server.clientDidDisconnect(42)
        XCTAssertTrue(events.value.isEmpty, "an unupgraded connection close is a no-op")
        XCTAssertFalse(server.hasConnectedClients)
    }

    // MARK: - Inbound frame unmasking (#5477 wire micro-opt)

    /// The vectorized unmask must produce byte-for-byte the same result as the
    /// reference per-byte XOR it replaces, across payload sizes and mask offsets.
    func testUnmaskFrameMatchesReferenceXor() {
        let mask: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        let payload = Array("Hello, WebSocket unmasking! 0123456789".utf8)
        var frame = Data(mask)
        frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })

        XCTAssertEqual(Array(WebSocketConnection.unmaskFrame(frame)), payload)
    }

    /// A masked frame with a zero-length payload (mask key only) unmasks to empty.
    func testUnmaskFrameEmptyPayload() {
        let frame = Data([0x01, 0x02, 0x03, 0x04])
        XCTAssertEqual(WebSocketConnection.unmaskFrame(frame), Data())
    }

    /// A single-byte payload exercises the offset-0 mask byte only.
    func testUnmaskFrameSingleByte() {
        let mask: [UInt8] = [0xAA, 0xBB, 0xCC, 0xDD]
        let payload: [UInt8] = [0x42]
        var frame = Data(mask)
        frame.append(payload[0] ^ mask[0])
        XCTAssertEqual(Array(WebSocketConnection.unmaskFrame(frame)), payload)
    }

    /// The received `Data` may be a slice with a non-zero start index; the helper
    /// must index relative to the slice, not the backing buffer.
    func testUnmaskFrameHandlesSlicedData() {
        let mask: [UInt8] = [0x11, 0x22, 0x33, 0x44]
        let payload = Array("sliced payload crossing the mask several times".utf8)
        var full = Data([0xDE, 0xAD]) // leading bytes so the frame is a mid-buffer slice
        full.append(Data(mask))
        full.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
        let slice = full.suffix(from: 2)

        XCTAssertEqual(Array(WebSocketConnection.unmaskFrame(slice)), payload)
    }
}

/// A minimal raw-socket WebSocket client for tests that need to drive frame-level
/// behavior `URLSession.webSocketTask` cannot express — specifically sending a
/// **fragmented** message (FIN=0 initial + continuation frames) with a control
/// frame interleaved (issue #5674). It performs the HTTP upgrade by hand, then
/// sends properly masked client frames (RFC 6455 §5.3) and parses the server's
/// unmasked reply frames back into JSON objects.
private final class RawWebSocketClient: @unchecked Sendable {
    enum ClientError: Error {
        case timeout(String)
        case handshake(String)
    }

    private let connection: NWConnection
    private let queue = DispatchQueue(label: "test.rawws.client")
    private let lock = NSLock()
    private var buffer = Data()

    init(port: UInt16) {
        let params = NWParameters.tcp
        connection = NWConnection(
            host: "127.0.0.1",
            port: NWEndpoint.Port(integerLiteral: port),
            using: params
        )
    }

    func close() {
        connection.cancel()
    }

    /// Opens the TCP connection, sends a WebSocket upgrade request, and blocks
    /// until the `101` response headers are received. Any bytes after the header
    /// separator (e.g. the server's `connected` event frame) are retained for
    /// later frame parsing, then a background receive loop is started.
    func connectAndUpgrade(timeout: TimeInterval) throws {
        let ready = DispatchSemaphore(value: 0)
        connection.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        connection.start(queue: queue)
        guard ready.wait(timeout: .now() + timeout) == .success else {
            throw ClientError.timeout("connection not ready")
        }

        let request = [
            "GET / HTTP/1.1",
            "Host: 127.0.0.1",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
        ].joined(separator: "\r\n")
        connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })

        let deadline = Date().addingTimeInterval(timeout)
        var httpBuffer = Data()
        let separator = Data("\r\n\r\n".utf8)
        while Date() < deadline {
            let chunk = try receiveOnce(timeout: deadline.timeIntervalSinceNow)
            httpBuffer.append(chunk)
            guard let sepRange = httpBuffer.range(of: separator) else { continue }

            let headerData = httpBuffer.subdata(in: httpBuffer.startIndex ..< sepRange.upperBound)
            guard let header = String(data: headerData, encoding: .utf8), header.contains("101") else {
                let headerText = String(data: headerData, encoding: .utf8) ?? "<non-utf8 header>"
                throw ClientError.handshake("expected 101 Switching Protocols, got: \(headerText)")
            }
            let leftover = httpBuffer.subdata(in: sepRange.upperBound ..< httpBuffer.endIndex)
            lock.lock()
            buffer.append(leftover)
            lock.unlock()
            startReceiveLoop()
            return
        }
        throw ClientError.timeout("handshake headers not received")
    }

    /// Sends one client→server frame, masked as §5.3 requires. Test payloads are
    /// all < 126 bytes, so only the 7-bit length form is emitted.
    func sendFrame(opcode: UInt8, fin: Bool, payload: Data) {
        var frame = Data()
        frame.append((fin ? 0x80 : 0x00) | opcode)
        frame.append(0x80 | UInt8(payload.count)) // mask bit set + 7-bit length
        let mask: [UInt8] = [0x12, 0x34, 0x56, 0x78]
        frame.append(contentsOf: mask)
        for (i, byte) in payload.enumerated() {
            frame.append(byte ^ mask[i % 4])
        }
        connection.send(content: frame, completion: .contentProcessed { _ in })
    }

    /// Polls parsed server frames until one decodes to a JSON object satisfying
    /// `predicate`, or the timeout elapses.
    func waitForMessage(
        timeout: TimeInterval,
        where predicate: ([String: Any]) -> Bool
    ) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let object = nextMatchingMessage(predicate) {
                return object
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        throw ClientError.timeout("no matching message within \(timeout)s")
    }

    private func receiveOnce(timeout: TimeInterval) throws -> Data {
        let sem = DispatchSemaphore(value: 0)
        var received = Data()
        var caught: Error?
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, error in
            if let error = error { caught = error }
            if let data = data { received = data }
            sem.signal()
        }
        guard sem.wait(timeout: .now() + max(timeout, 0.1)) == .success else {
            throw ClientError.timeout("receive timed out")
        }
        if let caught = caught { throw caught }
        return received
    }

    private func startReceiveLoop() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                self.lock.lock()
                self.buffer.append(data)
                self.lock.unlock()
            }
            if error != nil || isComplete { return }
            self.startReceiveLoop()
        }
    }

    /// Consumes complete frames from the head of the buffer, returning the first
    /// text/binary frame whose JSON body satisfies `predicate`. Control and
    /// non-matching frames are skipped. Returns nil when no complete matching
    /// frame is available yet.
    private func nextMatchingMessage(_ predicate: ([String: Any]) -> Bool) -> [String: Any]? {
        while true {
            lock.lock()
            // Convert to a 0-based array so indexing is safe regardless of the
            // Data's start index after prior `removeFirst` calls.
            let bytes = [UInt8](buffer)
            lock.unlock()
            guard bytes.count >= 2 else { return nil }

            let firstByte = bytes[0]
            let secondByte = bytes[1]
            let opcode = firstByte & 0x0F
            var payloadLength = Int(secondByte & 0x7F)
            var headerLength = 2
            if payloadLength == 126 {
                guard bytes.count >= 4 else { return nil }
                payloadLength = Int(bytes[2]) << 8 | Int(bytes[3])
                headerLength = 4
            } else if payloadLength == 127 {
                return nil // not produced by the server for test-sized payloads
            }
            let maskLength = (secondByte & 0x80) != 0 ? 4 : 0
            let totalLength = headerLength + maskLength + payloadLength
            guard bytes.count >= totalLength else { return nil }

            let payload = Data(bytes[(headerLength + maskLength) ..< totalLength])
            lock.lock()
            buffer.removeFirst(totalLength)
            lock.unlock()

            if opcode == 0x01 || opcode == 0x02 {
                if let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                   predicate(object) {
                    return object
                }
            }
            // Otherwise (control frame, or non-matching data frame) keep parsing.
        }
    }
}

/// Lock-protected reference cell so an escaping completion handler can publish a
/// result back to the test thread. Access is synchronized because the timeout
/// path has no happens-before: if `healthDone.wait` times out, the driver tears
/// down the session, whose cancelled `dataTask` completion still fires and writes
/// `value` concurrently with the main thread's post-`wait` read. The lock keeps
/// that access defined (matching `LockingResponder`'s pattern above).
private final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T

    init(_ value: T) { _value = value }

    var value: T {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _value
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            _value = newValue
        }
    }
}
