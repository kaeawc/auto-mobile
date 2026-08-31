extension AutoMobilePlanExecutor {
    public enum ExecutorError: Error, CustomStringConvertible, Sendable {
        case planNotFound(String)
        case invalidPlan(String)
        case mcpFailure(String)
        case executionFailed(String)
        case invalidResponse(String)

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
            }
        }

        public var isRetryable: Bool {
            switch self {
            case .planNotFound, .invalidPlan:
                return false
            case .mcpFailure, .executionFailed, .invalidResponse:
                return true
            }
        }
    }
}
