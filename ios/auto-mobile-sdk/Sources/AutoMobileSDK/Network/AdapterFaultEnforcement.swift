import Foundation
import Network

/// What a WebSocket or NWConnection adapter does with a matched fault rule (#5163).
///
/// Adapters apply `latency` (delay) and `error` / `closeConnection` (fail, after any configured
/// delay). Every other action is matched, recorded as unsupported and not applied, so a rule never
/// claims an effect the transport did not have.
enum AdapterFaultOutcome: Equatable, Sendable {
    case proceed
    case delay(faultId: String, delayMs: Int)
    case fail(faultId: String, action: NetworkFaultAction, errorType: String?, delayMs: Int)
    case unsupported(faultId: String, action: NetworkFaultAction)

    /// The rule actions the adapter transports apply, as reported in their capability descriptor.
    static let enforcedActions: [NetworkFaultAction] = [.closeConnection, .error, .latency]

    #if DEBUG
        init(_ decision: NetworkMockRuleStore.FaultDecision?) {
            guard let decision, !decision.dryRun else {
                self = .proceed
                return
            }
            let delayMs = max(0, decision.delayMs ?? 0)
            switch decision.action {
            case .latency:
                self = delayMs > 0 ? .delay(faultId: decision.faultId, delayMs: delayMs) : .proceed
            case .error, .closeConnection:
                self = .fail(
                    faultId: decision.faultId, action: decision.action,
                    errorType: decision.errorType, delayMs: delayMs
                )
            case .response, .status, .bandwidth, .dropBytes, .rejectFrame:
                self = .unsupported(faultId: decision.faultId, action: decision.action)
            }
        }
    #endif

    /// The error string recorded for a failed exchange, in the URLProtocol's `fault:<id>:<action>` form.
    var recordedError: String? {
        guard case let .fail(faultId, action, _, _) = self else { return nil }
        return "fault:\(faultId):\(action.rawValue)"
    }

    /// Request metadata describing the rule decision and what the adapter did with it.
    var metadata: [String: String] {
        switch self {
        case .proceed:
            [:]
        case let .delay(faultId, delayMs):
            ["fault_id": faultId, "fault_action": NetworkFaultAction.latency.rawValue,
             "fault_outcome": "delayed", "fault_delay_ms": String(delayMs)]
        case let .fail(faultId, action, _, delayMs):
            ["fault_id": faultId, "fault_action": action.rawValue,
             "fault_outcome": "failed", "fault_delay_ms": String(delayMs)]
        case let .unsupported(faultId, action):
            ["fault_id": faultId, "fault_action": action.rawValue, "fault_outcome": "unsupported"]
        }
    }

    /// The POSIX code an NWConnection fail rule reports, by the rule's `errorType`.
    static func posixCode(for errorType: String?) -> POSIXErrorCode {
        switch errorType {
        case "connectionReset", "reset": .ECONNRESET
        case "timeout": .ETIMEDOUT
        case "dnsFailure": .EHOSTUNREACH
        default: .ECONNREFUSED
        }
    }
}

/// A WebSocket message payload that can cross a delayed (`@Sendable`) hop.
enum WebSocketPayload: Equatable, Sendable {
    case text(String)
    case data(Data)

    init(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case let .string(text): self = .text(text)
        case let .data(data): self = .data(data)
        @unknown default: self = .data(Data())
        }
    }

    var message: URLSessionWebSocketTask.Message {
        switch self {
        case let .text(text): .string(text)
        case let .data(data): .data(data)
        }
    }

    var frameType: WebSocketFrameType {
        switch self {
        case .text: .text
        case .data: .binary
        }
    }

    var payloadSize: Int {
        switch self {
        case let .text(text): text.utf8.count
        case let .data(data): data.count
        }
    }
}

/// The `URLSessionWebSocketTask` calls the WebSocket adapter makes, so tests can drive it without
/// a socket.
struct WebSocketOperations: Sendable {
    let url: String
    let send: @Sendable (WebSocketPayload, @escaping @Sendable (Error?) -> Void) -> Void
    let receive: @Sendable (@escaping @Sendable (Result<WebSocketPayload, Error>) -> Void) -> Void
    let close: @Sendable (_ reset: Bool, _ reason: String) -> Void
}

extension WebSocketOperations {
    init(task: URLSessionWebSocketTask) {
        url = (task.originalRequest ?? task.currentRequest)?.url?.absoluteString ?? ""
        send = { payload, done in
            task.send(payload.message) { error in done(error) }
        }
        receive = { done in
            task.receive { result in done(result.map(WebSocketPayload.init)) }
        }
        close = { reset, reason in
            if reset {
                task.cancel()
            } else {
                task.cancel(with: .goingAway, reason: Data(reason.utf8))
            }
        }
    }
}

/// The `NWConnection` calls the NWConnection adapter makes, so tests can drive it without a socket.
struct ConnectionOperations: Sendable {
    let start: @Sendable () -> Void
    let cancel: @Sendable () -> Void
}

extension ConnectionOperations {
    init(connection: NWConnection, queue: DispatchQueue) {
        start = { connection.start(queue: queue) }
        cancel = { connection.cancel() }
    }
}
