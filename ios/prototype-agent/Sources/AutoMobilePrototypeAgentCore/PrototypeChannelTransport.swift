import Foundation

/// Transport callbacks are marshalled to the main actor by the transport adapter. No device or
/// host transport is installed in this slice; tests drive the listener explicitly.
@MainActor
protocol PrototypeChannelTransport {
    func open(_ request: PrototypeChannelOpenRequest, listener: PrototypeChannelListener) throws
        -> any PrototypeChannelConnection
}

@MainActor
protocol PrototypeChannelConnection {
    func send(_ text: String) -> Bool
    /// Idempotent; must not report another listener callback.
    func close(code: Int, reason: String)
}

struct PrototypeChannelOpenRequest: Equatable {
    let connectionID: String
    let prototypeID: String
    let channel: String
    let declaration: [String: JSONValue]
    let lastEventID: String?
}

@MainActor
struct PrototypeChannelListener {
    let opened: () -> Void
    let frame: (_ text: String, _ event: String?, _ id: String?) -> Void
    let closed: (_ code: Int?, _ reason: String?, _ error: PrototypeChannelError?) -> Void
}

struct PrototypeChannelError: Error, Equatable {
    let code: String
    let message: String
    var status: Int?

    var json: JSONValue {
        var fields: [String: JSONValue] = ["code": .string(code), "message": .string(message)]
        if let status { fields["status"] = .number(Double(status)) }
        return .object(fields)
    }
}

@MainActor
struct PrototypeRealtimeConfig {
    let host: any PrototypeChannelTransport
    let device: any PrototypeChannelTransport
    var random: () -> Double = { Double.random(in: 0 ..< 1) }
    var newID: () -> String = { UUID().uuidString }
}

/// One effect is committed under one runtime-exclusive section: state, event and handler writes
/// cannot interleave with a patch or another frame. The guard is checked AFTER entering it.
struct PrototypeChannelEffect {
    let channel: String
    let declaration: [String: JSONValue]
    var state: JSONValue?
    var eventName: String?
    var event: JSONValue = .null
    var actions: [JSONValue] = []
}

@MainActor
struct PrototypeChannelSink {
    typealias Exclusive = (@MainActor () throws -> Void) async throws -> Void
    let exclusively: Exclusive
    let isCurrent: (String) -> Bool
    let apply: (PrototypeChannelEffect) throws -> Void

    func commit(_ effect: PrototypeChannelEffect) async throws {
        try await exclusively {
            guard isCurrent(effect.channel) else { return }
            try apply(effect)
        }
    }
}
