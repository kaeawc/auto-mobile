import Foundation
import XCTest

/// A minimal `CodingKey` for building synthetic `DecodingError`s whose `codingPath`
/// pins a specific field name, so the field-attributed wire messages can be tested
/// deterministically (mirrors the reference `TypedRequestDecodeTests` helper).
private struct FramingTestKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { self.intValue = intValue; stringValue = String(intValue) }
}

/// Differential parity for the pure RFC-6455 framing codec + fragmentation state
/// machine (`WebSocketFraming`) and the wire-error string mapping (`WireError`),
/// rewrite Phase 1. Identical inputs must yield identical outputs in both modules —
/// byte-for-byte for frames, exact strings for errors.
final class FramingParityTests: XCTestCase {
    // MARK: - Frame construction

    func testCreateWebSocketFrameBytesMatch() {
        let lengths = [0, 1, 5, 125, 126, 200, 65535, 65536, 100_000]
        let opcodes: [UInt8] = [0x01, 0x02, 0x08, 0x09, 0x0A]
        for length in lengths {
            let data = Data((0 ..< length).map { UInt8($0 & 0xFF) })
            for opcode in opcodes {
                XCTAssertEqual(
                    ReferenceFraming.createFrame(data: data, opcode: opcode),
                    RewriteFraming.createFrame(data: data, opcode: opcode),
                    "frame bytes differ for length=\(length) opcode=\(opcode)"
                )
            }
        }
    }

    func testUnmaskFrameBytesMatch() {
        // 4-byte masking key followed by masked payload of varying lengths.
        for payloadLength in [0, 1, 3, 4, 5, 16, 1000] {
            let key: [UInt8] = [0xA1, 0xB2, 0xC3, 0xD4]
            let masked = key + (0 ..< payloadLength).map { UInt8(($0 * 7) & 0xFF) }
            let frame = Data(masked)
            XCTAssertEqual(
                ReferenceFraming.unmask(frame),
                RewriteFraming.unmask(frame),
                "unmasked bytes differ for payloadLength=\(payloadLength)"
            )
        }
    }

    // MARK: - Sizing / predicates

    func testFrameReadLengthMatches() {
        let cases: [(UInt64, Bool)] = [
            (0, false), (0, true), (10, false), (10, true),
            (64 * 1024 * 1024, false),        // exactly max
            (64 * 1024 * 1024 + 1, false),     // over max → nil
            (UInt64(Int.max) + 1, true),       // way over → nil
        ]
        for (payloadLength, isMasked) in cases {
            XCTAssertEqual(
                ReferenceFraming.frameReadLength(payloadLength: payloadLength, isMasked: isMasked),
                RewriteFraming.frameReadLength(payloadLength: payloadLength, isMasked: isMasked),
                "frameReadLength differs for (\(payloadLength), \(isMasked))"
            )
        }
    }

    func testControlAndDataOpcodePredicatesMatch() {
        for n: UInt64 in [0, 1, 125, 126, 1000] {
            XCTAssertEqual(ReferenceFraming.isValidControl(n), RewriteFraming.isValidControl(n), "isValidControl(\(n))")
        }
        for opcode: UInt8 in [0x00, 0x01, 0x02, 0x08, 0x09, 0x0A, 0x03] {
            XCTAssertEqual(
                ReferenceFraming.isDataOrContinuation(opcode),
                RewriteFraming.isDataOrContinuation(opcode),
                "isDataOrContinuation(\(opcode))"
            )
        }
    }

    func testFrameActionMatches() {
        let payload = Data("ping-body".utf8)
        for opcode: UInt8 in [0x01, 0x02, 0x09, 0x0A, 0x08, 0x00] {
            let reference = ReferenceFraming.frameAction(opcode: opcode, unmaskedPayload: payload)
            let rewrite = RewriteFraming.frameAction(opcode: opcode, unmaskedPayload: payload)
            XCTAssertEqual(reference.tag, rewrite.tag, "frameAction tag for opcode \(opcode)")
            XCTAssertEqual(reference.data, rewrite.data, "frameAction data for opcode \(opcode)")
        }
    }

    // MARK: - Pre-read admission

    func testPreReadDecisionMatches() {
        let cases: [(opcode: UInt8, len: UInt64, inProgress: UInt8?, buffered: Int)] = [
            (0x01, 10, nil, 0),                          // read
            (0x01, 10, 0x01, 0),                         // reject: data while open
            (0x01, 64 * 1024 * 1024 + 1, nil, 0),        // reject: oversize
            (0x00, 10, nil, 0),                          // reject: continuation, none open
            (0x00, 10, 0x01, 100),                       // read
            (0x00, 64 * 1024 * 1024, 0x01, 1),           // reject: reassembled oversize
            (0x03, 10, nil, 0),                          // reject: unsupported opcode
        ]
        for c in cases {
            let reference = ReferenceFraming.preReadDecision(opcode: c.opcode, declaredPayloadLength: c.len, inProgressOpcode: c.inProgress, alreadyBuffered: c.buffered)
            let rewrite = RewriteFraming.preReadDecision(opcode: c.opcode, declaredPayloadLength: c.len, inProgressOpcode: c.inProgress, alreadyBuffered: c.buffered)
            XCTAssertEqual(reference.tag, rewrite.tag, "preRead tag for \(c)")
            XCTAssertEqual(reference.reason, rewrite.reason, "preRead reason for \(c)")
        }
    }

    // MARK: - Fragmentation reassembly

    func testAccumulateMatches() {
        struct Step { let buffer: Data; let opcode: UInt8; let isFinal: Bool; let payload: Data; let inProgress: UInt8? }
        let he = Data("he".utf8), llo = Data("llo".utf8), bang = Data("!".utf8), hello = Data("hello".utf8)
        let steps: [Step] = [
            Step(buffer: Data(), opcode: 0x01, isFinal: true, payload: hello, inProgress: nil),   // single message
            Step(buffer: Data(), opcode: 0x01, isFinal: false, payload: he, inProgress: nil),     // start fragment
            Step(buffer: he, opcode: 0x00, isFinal: false, payload: llo, inProgress: 0x01),       // continue
            Step(buffer: hello, opcode: 0x00, isFinal: true, payload: bang, inProgress: 0x01),    // final continuation
            Step(buffer: Data(), opcode: 0x00, isFinal: true, payload: bang, inProgress: nil),    // protocol error: no message
            Step(buffer: he, opcode: 0x01, isFinal: true, payload: hello, inProgress: 0x01),      // protocol error: data while open
            Step(buffer: Data(), opcode: 0x03, isFinal: true, payload: bang, inProgress: nil),    // protocol error: bad opcode
        ]
        for (i, s) in steps.enumerated() {
            let reference = ReferenceFraming.accumulate(buffer: s.buffer, opcode: s.opcode, isFinal: s.isFinal, payload: s.payload, inProgressOpcode: s.inProgress)
            let rewrite = RewriteFraming.accumulate(buffer: s.buffer, opcode: s.opcode, isFinal: s.isFinal, payload: s.payload, inProgressOpcode: s.inProgress)
            XCTAssertEqual(reference.tag, rewrite.tag, "accumulate[\(i)] tag")
            XCTAssertEqual(reference.data, rewrite.data, "accumulate[\(i)] data")
            XCTAssertEqual(reference.reason, rewrite.reason, "accumulate[\(i)] reason")
            XCTAssertEqual(reference.buffer, rewrite.buffer, "accumulate[\(i)] buffer")
            XCTAssertEqual(reference.inProgress, rewrite.inProgress, "accumulate[\(i)] inProgress")
        }
    }

    // MARK: - HTTP framing

    func testCompleteHTTPRequestLengthMatches() {
        let bodyless = Data("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n".utf8)
        let partialHeader = Data("GET /health HTTP/1.1\r\nHost: local".utf8)
        let withBody = Data("POST /sdk-events HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello".utf8)
        let partialBody = Data("POST /sdk-events HTTP/1.1\r\nContent-Length: 5\r\n\r\nhel".utf8)
        for data in [bodyless, partialHeader, withBody, partialBody] {
            XCTAssertEqual(
                ReferenceFraming.completeHTTPRequestLength(in: data),
                RewriteFraming.completeHTTPRequestLength(in: data),
                "completeHTTPRequestLength differs"
            )
        }
    }

    // MARK: - Handshake digest

    func testSha1Matches() {
        for s in ["", "abc", "dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11"] {
            let data = Data(s.utf8)
            XCTAssertEqual(ReferenceFraming.sha1(data), RewriteFraming.sha1(data), "sha1 differs for `\(s)`")
        }
    }

    // MARK: - Wire-error string mapping

    func testWireErrorMessagesMatch() {
        let fieldX = FramingTestKey(stringValue: "x")
        let fieldY = FramingTestKey(stringValue: "y")
        let overflowUnderlying = NSError(
            domain: NSCocoaErrorDomain, code: 3840,
            userInfo: [NSDebugDescriptionErrorKey: "Number 1e309 is not representable in Swift."]
        )
        let syntaxUnderlying = NSError(
            domain: NSCocoaErrorDomain, code: 3840,
            userInfo: [NSDebugDescriptionErrorKey: "Unexpected character ',' around line 1, column 6."]
        )
        let errors: [Error] = [
            DecodingError.typeMismatch(Int.self, .init(codingPath: [fieldX], debugDescription: "Expected to decode Int")),
            DecodingError.valueNotFound(String.self, .init(codingPath: [fieldY], debugDescription: "Cannot get value")),
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "corrupt", underlyingError: overflowUnderlying)),
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "corrupt", underlyingError: syntaxUnderlying)),
            DecodingError.keyNotFound(fieldX, .init(codingPath: [], debugDescription: "No value associated with key x")),
            NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "plain error"]),
        ]
        for error in errors {
            XCTAssertEqual(
                ReferenceFraming.wireErrorMessage(for: error),
                RewriteFraming.wireErrorMessage(for: error),
                "wire error message differs for \(error)"
            )
        }

        // CommandError is a per-module type, so exercise each module's own and assert
        // the shared expected text.
        XCTAssertEqual(ReferenceFraming.unknownCommandMessage("foo_cmd"), "Unknown command type: foo_cmd")
        XCTAssertEqual(RewriteFraming.unknownCommandMessage("foo_cmd"), "Unknown command type: foo_cmd")
    }

    func testExtractRequestIdMatches() {
        let cases = [
            #"{"requestId":"abc-123","type":"request_screenshot"}"#,
            #"{"type":"request_screenshot"}"#,          // no requestId
            #"{"requestId":42}"#,                        // non-string requestId
            #"[1,2,3]"#,                                  // not an object
            #"not json"#,                                 // invalid
        ]
        for json in cases {
            let data = Data(json.utf8)
            XCTAssertEqual(
                ReferenceFraming.extractRequestId(from: data),
                RewriteFraming.extractRequestId(from: data),
                "extractRequestId differs for `\(json)`"
            )
        }
    }
}
