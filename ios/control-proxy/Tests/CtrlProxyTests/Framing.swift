@testable import CtrlProxy
import Foundation

/// Drives the `CtrlProxy` framing (`WebSocketFraming`) + wire-error
/// (`WireError`) helpers. `@testable` reaches the internal
/// namespaces.
enum Framing {
    struct AccumulationResult {
        let tag: String
        let data: Data?
        let reason: String?
        let buffer: Data
        let inProgress: UInt8?
    }

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
        guard case let .complete(length) = classifyHTTPRequest(in: data) else { return nil }
        return length
    }

    static func classifyHTTPRequest(in data: Data) -> WebSocketFraming.HTTPRequestFraming {
        WebSocketFraming.classifyHTTPRequest(in: data)
    }

    static func sha1(_ data: Data) -> Data {
        data.sha1()
    }

    static func preReadDecision(
        opcode: UInt8,
        declaredPayloadLength: UInt64,
        inProgressOpcode: UInt8?,
        alreadyBuffered: Int
    )
        -> (tag: String, reason: String?)
    {
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
        case let .deliver(data): return ("deliver", data)
        case let .pong(data): return ("pong", data)
        case .ignore: return ("ignore", nil)
        }
    }

    static func accumulate(
        buffer: Data,
        opcode: UInt8,
        isFinal: Bool,
        payload: Data,
        inProgressOpcode: UInt8?
    )
        -> AccumulationResult
    {
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
        case let .deliver(data): return AccumulationResult(
                tag: "deliver",
                data: data,
                reason: nil,
                buffer: buf,
                inProgress: inProg
            )
        case .buffered: return AccumulationResult(
                tag: "buffered",
                data: nil,
                reason: nil,
                buffer: buf,
                inProgress: inProg
            )
        case let .protocolError(reason): return AccumulationResult(
                tag: "protocolError",
                data: nil,
                reason: reason,
                buffer: buf,
                inProgress: inProg
            )
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
