@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE framing + wire-error statics, returning module-agnostic
/// values. `@testable` reaches the internal `WebSocketConnection` / `WebSocketServer`
/// statics; only `CtrlProxy` is imported so the bare type names resolve
/// unambiguously (see `ReferenceWireDecoder`). In the reference these live as statics
/// on `WebSocketConnection` (framing) and `WebSocketServer` (wire-error); the rewrite
/// groups them into `WebSocketFraming` / `WireError`, so the parity test compares
/// behavior, not location.
enum ReferenceFraming {
    static func createFrame(data: Data, opcode: UInt8) -> Data {
        WebSocketConnection.createWebSocketFrame(data: data, opcode: opcode)
    }

    static func unmask(_ frame: Data) -> Data {
        WebSocketConnection.unmaskFrame(frame)
    }

    static func frameReadLength(payloadLength: UInt64, isMasked: Bool) -> Int? {
        WebSocketConnection.frameReadLength(payloadLength: payloadLength, isMasked: isMasked)
    }

    static func isValidControl(_ n: UInt64) -> Bool {
        WebSocketConnection.isValidControlFramePayloadLength(n)
    }

    static func isDataOrContinuation(_ opcode: UInt8) -> Bool {
        WebSocketConnection.isDataOrContinuation(opcode)
    }

    static func completeHTTPRequestLength(in data: Data) -> Int? {
        WebSocketConnection.completeHTTPRequestLength(in: data)
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
        switch WebSocketConnection.preReadDataFrameDecision(
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
        switch WebSocketConnection.frameAction(opcode: opcode, unmaskedPayload: unmaskedPayload) {
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
    ) -> (tag: String, data: Data?, reason: String?, buffer: Data, inProgress: UInt8?) {
        var buf = buffer
        var inProg = inProgressOpcode
        let result = WebSocketConnection.accumulate(
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
        WebSocketServer.wireErrorMessage(for: error)
    }

    static func unknownCommandMessage(_ type: String) -> String {
        WebSocketServer.wireErrorMessage(for: CommandError.unknownCommand(type))
    }

    static func extractRequestId(from data: Data) -> String? {
        WebSocketServer.extractRequestId(from: data)
    }
}
