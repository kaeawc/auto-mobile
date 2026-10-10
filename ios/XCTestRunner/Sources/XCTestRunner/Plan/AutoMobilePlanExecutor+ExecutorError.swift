extension AutoMobilePlanExecutor {
    public enum ExecutorError: Error, CustomStringConvertible, Sendable {
        case planNotFound(String)
        case invalidPlan(String)
        case mcpFailure(String)
        case executionFailed(String)
        case invalidResponse(String)
        /// The daemon refused `tool` with a typed error instead of running it (#11195).
        case refused(tool: String, DaemonRefusal)
        /// The bounded wait for a held device ran out; retrying immediately would hit the same holder.
        case deviceUnavailable(String)

        public var description: String {
            switch self {
            case let .planNotFound(path):
                return "Plan not found: \(path)"
            case let .invalidPlan(message):
                return "Invalid plan: \(message)"
            case let .mcpFailure(message):
                return "MCP failure: \(message)"
            case let .executionFailed(message):
                return "Plan execution failed: \(message)"
            case let .invalidResponse(message):
                return "Invalid response: \(message)"
            case let .refused(tool, refusal):
                let code = refusal.code.map { " (\($0))" } ?? ""
                return "Daemon refused \(tool)\(code): \(refusal.message)"
            case let .deviceUnavailable(message):
                return "Device unavailable: \(message)"
            }
        }

        public var isRetryable: Bool {
            switch self {
            case .planNotFound, .invalidPlan, .deviceUnavailable:
                return false
            case let .refused(_, refusal):
                // A typed refusal is retried only when the daemon says so, or under a fresh session
                // when it named this one terminal; an untyped failure keeps the blind retry.
                return refusal.retryable || refusal.acquiresNewSession || refusal.code == nil
            case .mcpFailure, .executionFailed, .invalidResponse:
                return true
            }
        }
    }
}
