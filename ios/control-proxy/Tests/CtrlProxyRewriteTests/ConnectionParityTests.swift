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
        XCTAssertEqual(rewrite.sends, reference.sends, "handshake output bytes must match the reference")
        XCTAssertEqual(rewrite.upgrades, reference.upgrades)
        XCTAssertEqual(rewrite.upgrades, 1, "onUpgrade should fire once")
        XCTAssertEqual(rewrite.messages, reference.messages)
        XCTAssertTrue(rewrite.messages.isEmpty, "handshake delivers no application messages")
        XCTAssertEqual(rewrite.closes, reference.closes)
        XCTAssertEqual(rewrite.closes, 0, "handshake does not close the connection")
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
