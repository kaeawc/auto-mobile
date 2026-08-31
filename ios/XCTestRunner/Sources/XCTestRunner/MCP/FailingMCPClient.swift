import Foundation

/// Production null-object: when a transport client cannot be constructed (e.g. an invalid
/// StreamableHTTP endpoint), the executor stores this so the failure surfaces on first use rather
/// than at construction. NOT a test double. `@unchecked Sendable` because the stored `error` is an
/// immutable `any Error` (not necessarily `Sendable`) that is only ever re-thrown.
final class FailingMCPClient: AutoMobileMCPClient, @unchecked Sendable {
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

    func resetSession() {}
}
