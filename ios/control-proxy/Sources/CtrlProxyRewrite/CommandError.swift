import Foundation

// MARK: - Errors

/// Structured command error surfaced to the WebSocket client.
///
/// Ported verbatim from the reference `CtrlProxy` target (issue #2859) — the exact
/// `errorDescription` strings are part of the external wire contract and must not
/// change. `unknownCommand`'s text in particular is string-matched by the TS
/// client's `rewriteUnknownCommandError` to warn that the deployed runner is older
/// than the daemon.
///
/// `Sendable` because the rewrite throws/returns this across actor boundaries
/// (`WebSocketRequest.init(from:)` throws it off the network queue).
public enum CommandError: LocalizedError, Sendable {
    case unknownCommand(String)
    case missingParameter(String)
    case invalidParameter(String, String)
    case executionFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .unknownCommand(cmd):
            // Wire text must stay "Unknown command type: <type>" — the TS client's
            // rewriteUnknownCommandError matches it to warn the runner is stale.
            return "Unknown command type: \(cmd)"
        case let .missingParameter(param):
            return "Missing required parameter: \(param)"
        case let .invalidParameter(param, value):
            return "Invalid value '\(value)' for parameter '\(param)'"
        case let .executionFailed(reason):
            return "Command execution failed: \(reason)"
        }
    }
}
