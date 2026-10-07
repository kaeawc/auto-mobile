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
    case gestureBoundExceeded(command: String, phase: String, boundMs: Int64, elapsedMs: Int64)
    case deadlineExceeded(command: String, deadlineMs: Int64, gestureCompleted: Bool)
    /// A queued command whose wire deadline passed before it reached the head of the queue (#10084).
    case expiredBeforeExecution(command: String, timeoutMs: Int64, queuedMs: Int64)

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
        case let .gestureBoundExceeded(command, phase, boundMs, elapsedMs):
            return "Command \(command) exceeded execution bound \(boundMs)ms in phase \(phase) after \(elapsedMs)ms; XCUITest call is still executing and the runner stays busy until it returns"
        case let .deadlineExceeded(command, deadlineMs, gestureCompleted):
            let outcome = gestureCompleted
                ? "gesture completed after its deadline; outcome is indeterminate"
                : "gesture was not started"
            return "Command \(command) exceeded deadline at \(deadlineMs)ms (\(outcome))"
        case let .expiredBeforeExecution(command, timeoutMs, queuedMs):
            return "Command \(command) expired before execution: it waited \(queuedMs)ms in the runner queue, past its \(timeoutMs)ms deadline; the command was not started"
        }
    }
}
