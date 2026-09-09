import Foundation

/// Pure RFC 6455 framing logic — the byte-level codec and fragmentation state
/// machine, decoupled from the stateful connection that drives it.
///
/// Ported verbatim from the reference target's `WebSocketConnection` statics; the
/// wire bytes these produce/consume are the frozen external contract. The stateful
/// reader/writer that calls these (receive loop, reassembly buffer ownership) lands
/// with the queue-confined `WebSocketConnection` in the networking phase. The nested
/// result enums are closely-related outputs of these functions and share this file.
enum WebSocketFraming {
    /// Maximum accepted WebSocket frame payload (64 MiB). Frames declaring a larger
    /// payload are rejected rather than trapping the `Int(length)` conversion (which
    /// crashes for `length > Int.max`) or attempting an enormous allocation (#3626).
    static let maxFramePayloadLength: UInt64 = 64 * 1024 * 1024

    /// RFC 6455 §5.5: a control-frame payload is at most 125 bytes and MUST NOT use
    /// the 126/127 extended-length forms (#5669).
    static let maxControlFramePayloadLength: UInt64 = 125

    /// Upper bound on a single buffered HTTP request (headers + body).
    static let maximumHTTPRequestLength = 1_000_000

    // MARK: - Frame read sizing

    /// Validate a frame payload length and compute the total bytes to read (payload
    /// + mask). Returns `nil` when the payload exceeds `maxPayload`, so the caller
    /// closes the connection instead of trapping/over-allocating.
    static func frameReadLength(
        payloadLength: UInt64,
        isMasked: Bool,
        maxPayload: UInt64 = maxFramePayloadLength
    ) -> Int? {
        guard payloadLength <= maxPayload else { return nil }
        return Int(payloadLength) + (isMasked ? 4 : 0)
    }

    // MARK: - Pre-read admission

    /// Whether a data/continuation frame may be received, decided from the frame
    /// header alone.
    enum FramePreReadDecision: Equatable {
        /// The frame is admissible — receive its payload, then hand to `accumulate`.
        case read
        /// The frame is malformed or would overflow the reassembly budget — close
        /// the connection without receiving it.
        case reject(String)
    }

    /// Decides, from the frame header **before** any payload is received or
    /// unmasked, whether a data (0x1/0x2) or continuation (0x0) frame can legally be
    /// accepted into the current reassembly state. Mirrors `accumulate`'s rejection
    /// conditions but runs pre-read, so a malformed/oversized frame is rejected
    /// without ever allocating (and, when masked, copying) a payload the server would
    /// immediately discard — bounding per-connection memory to ~1× the cap instead of
    /// ~3× (issue #5674 review). Only `.read` frames reach `accumulate`, which stays
    /// the post-read authority (defense in depth).
    static func preReadDataFrameDecision(
        opcode: UInt8,
        declaredPayloadLength: UInt64,
        inProgressOpcode: UInt8?,
        alreadyBuffered: Int,
        maxTotal: UInt64 = maxFramePayloadLength
    ) -> FramePreReadDecision {
        switch opcode {
        case 0x01, 0x02:
            if inProgressOpcode != nil {
                return .reject("new data frame (opcode 0x\(String(opcode, radix: 16))) while a fragmented message is open")
            }
            guard declaredPayloadLength <= maxTotal else {
                return .reject("frame payload exceeds \(maxTotal) bytes")
            }
            return .read
        case 0x00:
            guard inProgressOpcode != nil else {
                return .reject("continuation frame with no message in progress")
            }
            guard UInt64(alreadyBuffered) + declaredPayloadLength <= maxTotal else {
                return .reject("reassembled message exceeds \(maxTotal) bytes")
            }
            return .read
        default:
            return .reject("unsupported opcode 0x\(String(opcode, radix: 16))")
        }
    }

    // MARK: - Unmasking

    /// Unmask a masked WebSocket frame whose first 4 bytes are the masking key and
    /// whose remaining bytes are the masked payload (RFC 6455 §5.3). Pre-sizes the
    /// output and XORs through raw buffer pointers (issue #5477).
    static func unmaskFrame(_ frame: Data) -> Data {
        guard frame.count > 4 else { return Data() }
        let payloadCount = frame.count - 4
        var unmasked = Data(count: payloadCount)
        frame.withUnsafeBytes { (rawIn: UnsafeRawBufferPointer) in
            unmasked.withUnsafeMutableBytes { (rawOut: UnsafeMutableRawBufferPointer) in
                let src = rawIn.bindMemory(to: UInt8.self)
                let dst = rawOut.bindMemory(to: UInt8.self)
                for i in 0 ..< payloadCount {
                    dst[i] = src[4 + i] ^ src[i & 3]
                }
            }
        }
        return unmasked
    }

    static func isValidControlFramePayloadLength(_ payloadLength: UInt64) -> Bool {
        payloadLength <= maxControlFramePayloadLength
    }

    // MARK: - Frame action (post-read)

    /// What to do with a frame whose payload has been fully read and unmasked.
    /// Keeping the decision pure (opcode + unmasked bytes in, action out) lets the
    /// ping → pong-echo and data-delivery wiring be unit-tested without a socket (#5669).
    enum FrameAction: Equatable {
        /// Text/binary frame → deliver as an application message.
        case deliver(Data)
        /// Ping frame → reply with a pong echoing the application data (§5.5.3).
        case pong(Data)
        /// Pong and other non-actionable opcodes → consumed, nothing to emit.
        case ignore
    }

    static func frameAction(opcode: UInt8, unmaskedPayload: Data) -> FrameAction {
        switch opcode {
        case 0x01, 0x02: return .deliver(unmaskedPayload)
        case 0x09: return .pong(unmaskedPayload)
        default: return .ignore
        }
    }

    // MARK: - Fragmentation reassembly

    /// The outcome of applying one data/continuation frame to the reassembly buffer.
    enum AccumulateResult: Equatable {
        /// The message is complete → deliver these fully-reassembled bytes.
        case deliver(Data)
        /// The fragment was appended in place; more frames are expected.
        case buffered
        /// A malformed fragmentation sequence or an exceeded total-size bound → the
        /// caller closes the connection rather than mis-delivering (§5.4).
        case protocolError(String)
    }

    /// Applies one data/continuation frame to the in-progress reassembly state,
    /// mutating the caller-owned `buffer` and `inProgressOpcode` **in place**
    /// (RFC 6455 §5.4). Appending via `inout` (rather than returning a freshly
    /// concatenated `Data`) keeps reassembly amortized O(total) instead of O(total²)
    /// (issue #5674 review).
    static func accumulate(
        into buffer: inout Data,
        opcode: UInt8,
        isFinal: Bool,
        payload: Data,
        inProgressOpcode: inout UInt8?,
        maxTotal: UInt64 = maxFramePayloadLength
    ) -> AccumulateResult {
        switch opcode {
        case 0x01, 0x02:
            // A new data frame is illegal while a fragmented message is still open.
            if inProgressOpcode != nil {
                return .protocolError("new data frame (opcode 0x\(String(opcode, radix: 16))) while a fragmented message is open")
            }
            guard UInt64(payload.count) <= maxTotal else {
                return .protocolError("frame payload exceeds \(maxTotal) bytes")
            }
            if isFinal {
                // Single, unfragmented message — deliver directly, no buffering.
                return .deliver(payload)
            }
            // Start a fragmented message: the payload seeds the buffer.
            inProgressOpcode = opcode
            buffer = payload
            return .buffered

        case 0x00:
            // A continuation frame requires an in-progress message.
            guard inProgressOpcode != nil else {
                return .protocolError("continuation frame with no message in progress")
            }
            guard UInt64(buffer.count) + UInt64(payload.count) <= maxTotal else {
                return .protocolError("reassembled message exceeds \(maxTotal) bytes")
            }
            buffer.append(payload)
            guard isFinal else {
                return .buffered
            }
            // Final continuation — hand off the accumulated bytes and reset.
            let message = buffer
            buffer = Data()
            inProgressOpcode = nil
            return .deliver(message)

        default:
            // Reserved / unexpected data opcode (control frames never reach here).
            return .protocolError("unsupported opcode 0x\(String(opcode, radix: 16))")
        }
    }

    /// Whether `opcode` denotes a data (text/binary) or continuation frame — the
    /// frames that participate in fragmentation reassembly (§5.4).
    static func isDataOrContinuation(_ opcode: UInt8) -> Bool {
        opcode == 0x00 || opcode == 0x01 || opcode == 0x02
    }

    // MARK: - Server → client frame construction

    /// Build an unmasked server→client frame (server frames are never masked,
    /// RFC 6455 §5.1).
    static func createWebSocketFrame(data: Data, opcode: UInt8) -> Data {
        var frame = Data()

        // FIN + opcode
        frame.append(0x80 | opcode)

        // Payload length (server doesn't mask)
        if data.count < 126 {
            frame.append(UInt8(data.count))
        } else if data.count < 65536 {
            frame.append(126)
            frame.append(UInt8((data.count >> 8) & 0xFF))
            frame.append(UInt8(data.count & 0xFF))
        } else {
            frame.append(127)
            for i in (0 ..< 8).reversed() {
                frame.append(UInt8((data.count >> (i * 8)) & 0xFF))
            }
        }

        frame.append(data)
        return frame
    }

    // MARK: - HTTP framing

    /// Returns the byte count of one complete HTTP request, including its body, or
    /// `nil` until another network read supplies the missing bytes.
    static func completeHTTPRequestLength(in data: Data) -> Int? {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: separator) else {
            return nil
        }

        let headerLength = headerRange.upperBound
        guard let header = String(data: data.prefix(headerLength), encoding: .utf8) else {
            return nil
        }

        let contentLength = header
            .components(separatedBy: "\r\n")
            .compactMap { line -> Int? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard let delimiter = trimmed.firstIndex(of: ":") else {
                    return nil
                }
                let name = String(trimmed[..<delimiter])
                guard name.caseInsensitiveCompare("Content-Length") == .orderedSame
                else {
                    return nil
                }
                let value = String(trimmed[trimmed.index(after: delimiter)...].trimmingCharacters(in: .whitespaces))
                return Int(value)
            }
            .first ?? 0
        guard contentLength >= 0,
              headerLength <= maximumHTTPRequestLength - contentLength
        else {
            return nil
        }

        let requestLength = headerLength + contentLength
        return data.count >= requestLength ? requestLength : nil
    }
}
