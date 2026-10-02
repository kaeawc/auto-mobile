import Foundation

/// Production null-object: when a transport client cannot be constructed (e.g. an invalid
/// StreamableHTTP endpoint), the executor stores this so the failure surfaces on first use rather
/// than at construction. NOT a test double. Swift 6 errors are Sendable; the stored error is immutable
/// and only ever re-thrown, so the native async overloads need no unchecked state.
final class FailingMCPClient: AutoMobileMCPClient {
    private let error: any Error

    init(error: any Error) {
        self.error = error
    }

    func initialize(timeout _: TimeInterval) throws {
        throw error
    }

    func callTool(name _: String, arguments _: [String: Any], timeout _: TimeInterval) throws -> MCPToolResponse {
        throw error
    }

    func readResource(uri _: String, timeout _: TimeInterval) throws -> MCPResourceResponse {
        throw error
    }

    func initialize(timeout _: TimeInterval) async throws { throw error }

    func callTool(name _: String, arguments _: [String: Any], timeout _: TimeInterval) async throws -> MCPToolResponse {
        throw error
    }

    func readResource(uri _: String, timeout _: TimeInterval) async throws -> MCPResourceResponse { throw error }

    func resetSession() {}
}
