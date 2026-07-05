@testable import CtrlProxy
import XCTest

/// Locks the decode-failure → error-response path #2854 moved *out* of
/// `CommandHandler.handle` and *into* `WebSocketServer.handleMessage`'s `catch`
/// (WebSocketServer.swift): a command that fails to decode is caught,
/// `extractRequestId(from:)` recovers the correlation id from the raw JSON, and
/// `buildErrorResponseData` renders the wire envelope (issue #2859 part 4). That
/// path was previously asserted only by a comment.
///
/// `handleMessage` itself needs a live `NWConnection`, so these tests drive the
/// same two static steps its catch block runs — decode throws →
/// `extractRequestId` → `buildErrorResponseData` — which is the whole of the
/// untested logic; the surrounding `connection.send` is transport.
final class WebSocketServerTests: XCTestCase {
    /// Reproduce the `handleMessage` catch for a raw command expected to fail
    /// decoding, returning the parsed wire error envelope. Fails the test if the
    /// command unexpectedly decodes.
    private func errorEnvelope(
        forRawCommand json: String,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> [String: Any]
    {
        let data = Data(json.utf8)
        do {
            _ = try JSONDecoder().decode(WebSocketRequest.self, from: data)
            XCTFail("expected \(json) to fail decoding", file: file, line: line)
            return [:]
        } catch {
            // Mirror WebSocketServer.handleMessage's catch block exactly.
            let requestId = WebSocketServer.extractRequestId(from: data)
            let responseData = WebSocketServer.buildErrorResponseData(requestId: requestId, error: error)
            guard let object = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
                XCTFail("error response was not valid JSON", file: file, line: line)
                return [:]
            }
            return object
        }
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

    // MARK: - Decode-failure → error envelope

    /// An unknown command `type` (no enum case) is rejected at decode; the catch
    /// path yields a `type:"error"`, `success:false` envelope that preserves the
    /// requestId and carries the exact "Unknown command type: <type>" wire text
    /// the TS `rewriteUnknownCommandError` matches.
    func testUnknownCommandTypeYieldsErrorEnvelopePreservingRequestId() {
        let envelope = errorEnvelope(
            forRawCommand: #"{"type":"totally_unknown","requestId":"uc-99"}"#
        )
        assertErrorEnvelope(
            envelope,
            requestId: "uc-99",
            errorContains: "Unknown command type: totally_unknown"
        )
    }

    /// A missing required field (here `x` on `request_tap_coordinates`) is rejected
    /// at decode; the catch path still produces the structured error envelope with
    /// the requestId preserved and a non-empty error text.
    func testMissingRequiredFieldYieldsErrorEnvelopePreservingRequestId() {
        let envelope = errorEnvelope(
            forRawCommand: #"{"type":"request_tap_coordinates","requestId":"mf-1","y":2}"#
        )
        XCTAssertEqual(envelope["type"] as? String, "error")
        XCTAssertEqual(envelope["success"] as? Bool, false)
        XCTAssertEqual(envelope["requestId"] as? String, "mf-1")
        XCTAssertFalse((envelope["error"] as? String ?? "").isEmpty, "error text must be present")
    }

    /// When the raw JSON carries no requestId, the error envelope's requestId is
    /// null rather than fabricated.
    func testErrorEnvelopeHasNullRequestIdWhenAbsent() {
        let envelope = errorEnvelope(forRawCommand: #"{"type":"totally_unknown"}"#)
        assertErrorEnvelope(envelope, requestId: nil, errorContains: "Unknown command type")
    }

    // MARK: - extractRequestId

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
}
