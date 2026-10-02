import Foundation

/// Central Sendable transport seam with native async initialization, tool calls, and resource reads.
/// Arguments are handed to the operation and must not be mutated concurrently, including values
/// referenced by the dictionary. Native transports encode them before spawning child tasks.
public protocol AutoMobileMCPClient: Sendable {
    func initialize(timeout: TimeInterval) async throws
    func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) async throws -> MCPToolResponse
    func readResource(uri: String, timeout: TimeInterval) async throws -> MCPResourceResponse
    func resetSession()
}
