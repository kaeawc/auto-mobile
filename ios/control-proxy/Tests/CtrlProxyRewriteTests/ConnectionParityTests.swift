import Foundation
import XCTest

/// Differential parity for the stateful `WebSocketConnection` (rewrite Phase 2b),
/// driven through a scripted `ByteChannel` in both modules. This validates the
/// byte-critical handshake path end-to-end — `receiveHTTPUpgrade` →
/// `completeHTTPRequestLength` slice → `handleWebSocketUpgrade` → SHA-1
/// `Sec-WebSocket-Accept` → 101 response → `onUpgrade` → `sendConnectedEvent` — and
/// the queue-confinement (the `dispatchPrecondition`s hold because everything runs on
/// the connection's serial queue).
///
/// (More scenarios — post-upgrade frames, ping→pong, close, fragmentation, and the
/// HTTP endpoints — build on this same harness in follow-up steps.)
final class ConnectionParityTests: XCTestCase {
    /// Canonical RFC 6455 upgrade request; the example key maps to the well-known
    /// accept value `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`.
    private let upgradeRequest = Data(
        "GET /ws HTTP/1.1\r\nHost: localhost:8765\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n".utf8
    )

    func testHandshakeProducesIdenticalBytesInBothModules() {
        let reference = ReferenceConnectionDriver.run(inbound: upgradeRequest)
        let rewrite = RewriteConnectionDriver.run(inbound: upgradeRequest)

        // Two outbound sends: the 101 response, then the framed `connected` event.
        XCTAssertEqual(reference.sends.count, 2, "reference should send 101 + connected event")
        assertHandshakeSendsEquivalent(rewrite.sends, reference.sends)
        XCTAssertEqual(rewrite.upgrades, reference.upgrades)
        XCTAssertEqual(rewrite.upgrades, 1, "onUpgrade should fire once")
        XCTAssertEqual(rewrite.messages, reference.messages)
        XCTAssertTrue(rewrite.messages.isEmpty, "handshake delivers no application messages")
        XCTAssertEqual(rewrite.closes, reference.closes)
        XCTAssertEqual(rewrite.closes, 0, "handshake does not close the connection")
    }

    /// Compare handshake sends for wire equivalence: the byte-critical framing (HTTP 101
    /// response, WebSocket frame header) must match exactly, but a JSON body is compared
    /// key-order-independently.
    ///
    /// The `connected` event's object key ORDER is not part of the frozen wire contract —
    /// the TS client parses it as JSON. Neither the reference (`WebSocketServer.sharedEncoder`)
    /// nor the rewrite (`sendConnectedEvent`) sorts keys, and swift-foundation's synthesized
    /// `Codable` key order for the two structs is not stable across process launches (the
    /// Swift-5-mode reference and Swift-6-mode rewrite can emit `{"id","type",…}` vs
    /// `{"type","id",…}` in different runs). A raw-byte comparison of that frame is therefore
    /// a pre-existing flake; normalizing the JSON body keeps the framing byte-exact while
    /// asserting the semantic wire contract. See STATUS §2.
    private func assertHandshakeSendsEquivalent(
        _ rewrite: [Data],
        _ reference: [Data],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(rewrite.count, reference.count, "handshake send count differs", file: file, line: line)
        for (index, pair) in zip(rewrite, reference).enumerated() {
            XCTAssertEqual(
                Self.canonicalizingJSONBody(pair.0),
                Self.canonicalizingJSONBody(pair.1),
                "handshake send[\(index)] differs (JSON body normalized to sorted keys)",
                file: file,
                line: line
            )
        }
    }

    /// Canonicalize a send: keep the byte-critical prefix (framing/headers) verbatim, and
    /// re-serialize any trailing JSON object with sorted keys. Non-JSON sends (the 101
    /// response) are returned unchanged.
    private static func canonicalizingJSONBody(_ data: Data) -> Data {
        guard let brace = data.firstIndex(of: UInt8(ascii: "{")) else { return data }
        let prefix = data[data.startIndex ..< brace]
        let body = data[brace...]
        guard let object = try? JSONSerialization.jsonObject(with: body),
              let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        else {
            return data
        }
        return Data(prefix) + sorted
    }

    /// The 101 response carries the correct RFC-6455 accept key (SHA-1 of key+GUID,
    /// base64), proving the handshake crypto end-to-end through the connection.
    func testHandshakeAcceptKeyIsCorrect() {
        let rewrite = RewriteConnectionDriver.run(inbound: upgradeRequest)
        guard let response = rewrite.sends.first,
              let text = String(data: response, encoding: .utf8)
        else {
            XCTFail("no upgrade response captured")
            return
        }
        XCTAssertTrue(text.hasPrefix("HTTP/1.1 101 Switching Protocols"), "expected a 101 response")
        XCTAssertTrue(
            text.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            "accept key must be base64(SHA1(key + magic GUID)); got:\n\(text)"
        )
    }
}
