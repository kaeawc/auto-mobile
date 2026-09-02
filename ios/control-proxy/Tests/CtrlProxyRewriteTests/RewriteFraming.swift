@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite` framing (`WebSocketFraming`) + wire-error
/// (`WireError`) helpers (see `ReferenceFraming`). `@testable` reaches the internal
/// namespaces.
enum RewriteFraming {
    static func createFrame(data: Data, opcode: UInt8) -> Data {
        WebSocketFraming.createWebSocketFrame(data: data, opcode: opcode)
    }

    static func unmask(_ frame: Data) -> Data {
        WebSocketFraming.unmaskFrame(frame)
    }

    static func frameReadLength(payloadLength: UInt64, isMasked: Bool) -> Int? {
        WebSocketFraming.frameReadLength(payloadLength: payloadLength, isMasked: isMasked)
    }

    static func isValidControl(_ n: UInt64) -> Bool {
        WebSocketFraming.isValidControlFramePayloadLength(n)
    }

    static func isDataOrContinuation(_ opcode: UInt8) -> Bool {
        WebSocketFraming.isDataOrContinuation(opcode)
    }

    static func completeHTTPRequestLength(in data: Data) -> Int? {
        WebSocketFraming.completeHTTPRequestLength(in: data)
    }

    static func sha1(_ data: Data) -> Data {
        data.sha1()
    }

    static func preReadDecision(
        opcode: UInt8,
        declaredPayloadLength: UInt64,
        inProgressOpcode: UInt8?,
        alreadyBuffered: Int
    ) -> (tag: String, reason: String?) {
        switch WebSocketFraming.preReadDataFrameDecision(
            opcode: opcode,
            declaredPayloadLength: declaredPayloadLength,
            inProgressOpcode: inProgressOpcode,
            alreadyBuffered: alreadyBuffered
        ) {
        case .read: return ("read", nil)
        case let .reject(reason): return ("reject", reason)
        }
    }

    static func frameAction(opcode: UInt8, unmaskedPayload: Data) -> (tag: String, data: Data?) {
        switch WebSocketFraming.frameAction(opcode: opcode, unmaskedPayload: unmaskedPayload) {
        case let .deliver(d): return ("deliver", d)
        case let .pong(d): return ("pong", d)
        case .ignore: return ("ignore", nil)
        }
    }

    static func accumulate(
        buffer: Data,
        opcode: UInt8,
        isFinal: Bool,
        payload: Data,
        inProgressOpcode: UInt8?
        // Module-agnostic parity tuple mirroring the framing result's five fields.
        // swiftlint:disable:next large_tuple
    ) -> (tag: String, data: Data?, reason: String?, buffer: Data, inProgress: UInt8?) {
        var buf = buffer
        var inProg = inProgressOpcode
        let result = WebSocketFraming.accumulate(
            into: &buf,
            opcode: opcode,
            isFinal: isFinal,
            payload: payload,
            inProgressOpcode: &inProg
        )
        switch result {
        case let .deliver(d): return ("deliver", d, nil, buf, inProg)
        case .buffered: return ("buffered", nil, nil, buf, inProg)
        case let .protocolError(reason): return ("protocolError", nil, reason, buf, inProg)
        }
    }

    static func wireErrorMessage(for error: Error) -> String {
        WireError.message(for: error)
    }

    static func unknownCommandMessage(_ type: String) -> String {
        WireError.message(for: CommandError.unknownCommand(type))
    }

    static func extractRequestId(from data: Data) -> String? {
        WireError.extractRequestId(from: data)
    }
}
