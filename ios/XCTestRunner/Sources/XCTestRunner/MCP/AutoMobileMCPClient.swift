import Foundation

/// The central transport seam. Deliberately SYNCHRONOUS: the executor is driven from synchronous
/// XCTest bodies and blocks on these calls (the concrete clients bridge async I/O internally). Refines
/// `Sendable` so the Sendable executor and recovery handler can hold it. `[String: Any]` arguments are
/// safe under strict concurrency because a synchronous same-isolation call never crosses a concurrency
/// boundary — and the concrete clients serialize the dict to `Data` before any thread hop.
public protocol AutoMobileMCPClient: Sendable {
    func initialize(timeout: TimeInterval) throws
    func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) throws -> MCPToolResponse
    func readResource(uri: String, timeout: TimeInterval) throws -> MCPResourceResponse
    func resetSession()
}
