import Foundation

/// Central Sendable transport seam. Async methods are the primary API; sync methods are deprecated
/// in documentation only and retained for source compatibility through PR 3 of the migration (#6061).
/// Swift allows a synchronous conformer method to witness the same-named async requirement. A
/// sync-only conformer invoked through the async API runs inline on the caller's executor and must
/// not block. Test doubles are non-blocking; real transports implement the async methods natively.
/// Arguments are handed to the operation and must not be mutated concurrently, including values
/// referenced by the dictionary. Native transports encode them before spawning child tasks.
public protocol AutoMobileMCPClient: Sendable {
    func initialize(timeout: TimeInterval) async throws
    func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) async throws -> MCPToolResponse
    func readResource(uri: String, timeout: TimeInterval) async throws -> MCPResourceResponse

    /// Deprecated: use the async overload; the sync API will be removed in the next minor release (issue #6061).
    /// Only for synchronous XCTest threads outside concurrency executors. Never call from the cooperative
    /// pool or @MainActor-isolated async code; the awaited operation must not require the main actor.
    func initialize(timeout: TimeInterval) throws
    /// Deprecated: use the async overload; the sync API will be removed in the next minor release (issue #6061).
    /// Only for synchronous XCTest threads outside concurrency executors. Never call from the cooperative
    /// pool or @MainActor-isolated async code; the awaited operation must not require the main actor.
    func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) throws -> MCPToolResponse
    /// Deprecated: use the async overload; the sync API will be removed in the next minor release (issue #6061).
    /// Only for synchronous XCTest threads outside concurrency executors. Never call from the cooperative
    /// pool or @MainActor-isolated async code; the awaited operation must not require the main actor.
    func readResource(uri: String, timeout: TimeInterval) throws -> MCPResourceResponse
    func resetSession()
}
