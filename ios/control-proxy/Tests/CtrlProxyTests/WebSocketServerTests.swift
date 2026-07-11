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

    private var perfProvider: PerfProvider!

    override func tearDown() {
        perfProvider?.clear()
        PerfProvider.resetInstance()
        super.tearDown()
    }

    /// A `WebSocketServer` wired to fakes, with a test perf provider so the
    /// singleton is untouched.
    private func makeServer() -> WebSocketServer {
        let fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        let handler = CommandHandler.createForTesting(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: perfProvider
        )
        return WebSocketServer(commandHandler: handler, perfProvider: perfProvider)
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
}
