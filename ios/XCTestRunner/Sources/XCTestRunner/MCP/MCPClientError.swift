public enum MCPClientError: Error, CustomStringConvertible, Equatable, Sendable {
    case invalidEndpoint(String)
    case invalidResponse(String)
    case serverError(String)
    case requestFailed(String)
    case sessionExpired

    public var description: String {
        switch self {
        case let .invalidEndpoint(message):
            return "Invalid MCP endpoint: \(message)"
        case let .invalidResponse(message):
            return "Invalid MCP response: \(message)"
        case let .serverError(message):
            return "MCP server error: \(message)"
        case let .requestFailed(message):
            return "MCP request failed: \(message)"
        case .sessionExpired:
            return "MCP session expired"
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .invalidEndpoint:
            return false
        case .invalidResponse:
            return false
        case .serverError:
            return true
        case .requestFailed:
            return true
        case .sessionExpired:
            return true
        }
    }
}
