import Foundation
import XCTest

/// A minimal `CodingKey` for building synthetic `DecodingError`s whose `codingPath`
/// pins a specific field name.
private struct FramingTestKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { self.intValue = intValue; stringValue = String(intValue) }
}

/// Reference-free invariant / known-value tests for the pure RFC-6455 framing codec + wire-error
/// mapping (`WebSocketFraming` / `WireError`).
///
/// Phase-7E re-anchor: was differential (byte/tag equality vs the reference). With the reference
/// retired these assert the codec contract directly — RFC-6455 header encoding + mask round-trip
/// (structural invariants), the documented admission/reassembly decisions (known tags), known
/// SHA-1 digests, and the frozen unknown-command wire text.
final class FramingParityTests: XCTestCase {
    // MARK: - Frame construction (RFC-6455 header encoding)

    func testCreateFrameHeaderEncoding() {
        for opcode: UInt8 in [0x01, 0x02, 0x09] {
            // Small payload (<126): 2-byte header, length in byte 1, FIN|opcode in byte 0.
            assertFrame(length: 5, opcode: opcode, expectedHeaderLength: 2) { frame, len in
                XCTAssertEqual(frame[1], UInt8(len), "1-byte length")
            }
            // 16-bit length (126...65535): byte1 == 126, big-endian length in bytes 2-3.
            assertFrame(length: 200, opcode: opcode, expectedHeaderLength: 4) { frame, len in
                XCTAssertEqual(frame[1], 126)
                XCTAssertEqual(Int(frame[2]) << 8 | Int(frame[3]), len, "16-bit big-endian length")
            }
            // 64-bit length (>65535): byte1 == 127, big-endian length in bytes 2-9.
            assertFrame(length: 100_000, opcode: opcode, expectedHeaderLength: 10) { frame, len in
                XCTAssertEqual(frame[1], 127)
                var decoded = 0
                for i in 2 ..< 10 { decoded = decoded << 8 | Int(frame[i]) }
                XCTAssertEqual(decoded, len, "64-bit big-endian length")
            }
        }
    }

    /// Builds a server frame and checks the FIN|opcode byte, header length, and that the payload
    /// is appended unmasked (server→client frames are never masked).
    private func assertFrame(
        length: Int, opcode: UInt8, expectedHeaderLength: Int,
        _ checkLengthField: (Data, Int) -> Void,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let data = Data((0 ..< length).map { UInt8($0 & 0xFF) })
        let frame = RewriteFraming.createFrame(data: data, opcode: opcode)
        XCTAssertEqual(frame[0], 0x80 | opcode, "FIN + opcode", file: file, line: line)
        XCTAssertEqual(frame.count, expectedHeaderLength + length, "frame length", file: file, line: line)
        checkLengthField(frame, length)
        XCTAssertEqual(Data(frame.suffix(length)), data, "payload appended unmasked", file: file, line: line)
    }

    func testUnmaskRoundTrip() {
        let key: [UInt8] = [0xA1, 0xB2, 0xC3, 0xD4]
        for payloadLength in [0, 1, 3, 4, 5, 16, 1000] {
            let payload = (0 ..< payloadLength).map { UInt8(($0 * 7) & 0xFF) }
            let masked = payload.enumerated().map { $0.element ^ key[$0.offset % 4] }
            let unmasked = RewriteFraming.unmask(Data(key + masked))
            XCTAssertEqual(Array(unmasked), payload, "unmask(key + payload^key) == payload for len=\(payloadLength)")
        }
    }

    // MARK: - Sizing / predicates

    func testFrameReadLength() {
        let rl = RewriteFraming.frameReadLength
        XCTAssertNotNil(rl(10, false), "valid length reads")
        XCTAssertNotNil(rl(64 * 1024 * 1024, false), "exactly max reads")
        // A masked frame reads exactly the 4 mask-key bytes more than an unmasked one.
        XCTAssertEqual(rl(10, true), rl(10, false).map { $0 + 4 }, "masked adds 4 key bytes")
        // Over the 64 MiB frame cap → nil (not read).
        XCTAssertNil(rl(64 * 1024 * 1024 + 1, false), "oversize → nil")
        XCTAssertNil(rl(UInt64(Int.max) + 1, true), "way oversize → nil")
    }

    func testControlAndDataOpcodePredicates() {
        for n: UInt64 in [0, 1, 125] { XCTAssertTrue(RewriteFraming.isValidControl(n), "control len \(n) ok") }
        for n: UInt64 in [126, 1000] { XCTAssertFalse(RewriteFraming.isValidControl(n), "control len \(n) invalid") }
        for opcode: UInt8 in [0x00, 0x01, 0x02] { XCTAssertTrue(RewriteFraming.isDataOrContinuation(opcode)) }
        for opcode: UInt8 in [0x08, 0x09, 0x0A, 0x03] { XCTAssertFalse(RewriteFraming.isDataOrContinuation(opcode)) }
    }

    func testFrameActionKnownTags() {
        let payload = Data("ping-body".utf8)
        // Data frames deliver; ping → pong (echo payload); pong → ignore.
        XCTAssertEqual(RewriteFraming.frameAction(opcode: 0x01, unmaskedPayload: payload).tag, "deliver")
        XCTAssertEqual(RewriteFraming.frameAction(opcode: 0x01, unmaskedPayload: payload).data, payload)
        XCTAssertEqual(RewriteFraming.frameAction(opcode: 0x09, unmaskedPayload: payload).tag, "pong")
        XCTAssertEqual(RewriteFraming.frameAction(opcode: 0x09, unmaskedPayload: payload).data, payload)
        XCTAssertEqual(RewriteFraming.frameAction(opcode: 0x0A, unmaskedPayload: payload).tag, "ignore")
    }

    // MARK: - Pre-read admission (documented decisions)

    func testPreReadDecisions() {
        func tag(_ opcode: UInt8, _ len: UInt64, _ inProgress: UInt8?, _ buffered: Int) -> String {
            RewriteFraming.preReadDecision(opcode: opcode, declaredPayloadLength: len, inProgressOpcode: inProgress, alreadyBuffered: buffered).tag
        }
        XCTAssertEqual(tag(0x01, 10, nil, 0), "read", "data, none open")
        XCTAssertEqual(tag(0x01, 10, 0x01, 0), "reject", "data while a message is open")
        XCTAssertEqual(tag(0x01, 64 * 1024 * 1024 + 1, nil, 0), "reject", "oversize")
        XCTAssertEqual(tag(0x00, 10, nil, 0), "reject", "continuation, none open")
        XCTAssertEqual(tag(0x00, 10, 0x01, 100), "read", "continuation of an open message")
        XCTAssertEqual(tag(0x03, 10, nil, 0), "reject", "unsupported opcode")
    }

    // MARK: - Fragmentation reassembly (documented decisions)

    func testAccumulateDecisions() {
        let he = Data("he".utf8), llo = Data("llo".utf8), bang = Data("!".utf8), hello = Data("hello".utf8)
        func acc(_ buffer: Data, _ opcode: UInt8, _ isFinal: Bool, _ payload: Data, _ inProgress: UInt8?) -> (tag: String, data: Data?) {
            let r = RewriteFraming.accumulate(buffer: buffer, opcode: opcode, isFinal: isFinal, payload: payload, inProgressOpcode: inProgress)
            return (r.tag, r.data)
        }
        // Single unfragmented text message → delivered whole.
        XCTAssertEqual(acc(Data(), 0x01, true, hello, nil).tag, "deliver")
        XCTAssertEqual(acc(Data(), 0x01, true, hello, nil).data, hello)
        // Start + continue fragments buffer; the final continuation delivers the assembly.
        XCTAssertEqual(acc(Data(), 0x01, false, he, nil).tag, "buffered")
        XCTAssertEqual(acc(he, 0x00, false, llo, 0x01).tag, "buffered")
        XCTAssertEqual(acc(hello, 0x00, true, bang, 0x01).tag, "deliver")
        // Protocol errors: continuation with nothing open, data while open, bad opcode.
        XCTAssertEqual(acc(Data(), 0x00, true, bang, nil).tag, "protocolError")
        XCTAssertEqual(acc(he, 0x01, true, hello, 0x01).tag, "protocolError")
        XCTAssertEqual(acc(Data(), 0x03, true, bang, nil).tag, "protocolError")
    }

    // MARK: - HTTP framing

    func testCompleteHTTPRequestLength() {
        let bodyless = Data("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n".utf8)
        let partialHeader = Data("GET /health HTTP/1.1\r\nHost: local".utf8)
        let withBody = Data("POST /sdk-events HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello".utf8)
        let partialBody = Data("POST /sdk-events HTTP/1.1\r\nContent-Length: 5\r\n\r\nhel".utf8)
        XCTAssertEqual(RewriteFraming.completeHTTPRequestLength(in: bodyless), bodyless.count, "complete bodyless request")
        XCTAssertNil(RewriteFraming.completeHTTPRequestLength(in: partialHeader), "incomplete header → nil")
        XCTAssertEqual(RewriteFraming.completeHTTPRequestLength(in: withBody), withBody.count, "complete request with body")
        XCTAssertNil(RewriteFraming.completeHTTPRequestLength(in: partialBody), "incomplete body → nil")
    }

    // MARK: - Handshake digest (known SHA-1 vectors)

    func testSha1KnownVectors() {
        func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
        XCTAssertEqual(hex(RewriteFraming.sha1(Data("".utf8))), "da39a3ee5e6b4b0d3255bfef95601890afd80709")
        XCTAssertEqual(hex(RewriteFraming.sha1(Data("abc".utf8))), "a9993e364706816aba3e25717850c26c9cd0d89d")
        // RFC-6455 §1.3 handshake example: SHA-1 of key + magic GUID.
        XCTAssertEqual(
            hex(RewriteFraming.sha1(Data("dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11".utf8))),
            "b37a4f2cc0624f1690f64606cf385945b2bec4ea"
        )
    }

    // MARK: - Wire-error string mapping

    func testUnknownCommandWireText() {
        // Frozen wire contract (matched by the TS `rewriteUnknownCommandError`).
        XCTAssertEqual(RewriteFraming.unknownCommandMessage("foo_cmd"), "Unknown command type: foo_cmd")
    }

    func testWireErrorMessagesNonEmpty() {
        let fieldX = FramingTestKey(stringValue: "x")
        let errors: [Error] = [
            DecodingError.typeMismatch(Int.self, .init(codingPath: [fieldX], debugDescription: "Expected to decode Int")),
            DecodingError.valueNotFound(String.self, .init(codingPath: [fieldX], debugDescription: "Cannot get value")),
            DecodingError.keyNotFound(fieldX, .init(codingPath: [], debugDescription: "No value associated with key x")),
            NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "plain error"]),
        ]
        for error in errors {
            XCTAssertFalse(RewriteFraming.wireErrorMessage(for: error).isEmpty, "wire error message for \(error)")
        }
    }

    func testExtractRequestId() {
        XCTAssertEqual(
            RewriteFraming.extractRequestId(from: Data(#"{"requestId":"abc-123","type":"request_screenshot"}"#.utf8)),
            "abc-123"
        )
        XCTAssertNil(RewriteFraming.extractRequestId(from: Data(#"{"type":"request_screenshot"}"#.utf8)), "no requestId")
        XCTAssertNil(RewriteFraming.extractRequestId(from: Data(#"{"requestId":42}"#.utf8)), "non-string requestId")
        XCTAssertNil(RewriteFraming.extractRequestId(from: Data(#"[1,2,3]"#.utf8)), "not an object")
        XCTAssertNil(RewriteFraming.extractRequestId(from: Data("not json".utf8)), "invalid json")
    }
}
