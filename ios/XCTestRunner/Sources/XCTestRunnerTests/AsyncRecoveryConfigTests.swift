import Foundation
import os
import XCTest
@testable import XCTestRunner

@MainActor
final class AsyncRecoveryConfigTests: XCTestCase {
    func testConstructionIsLazyAndAsyncReadIsCached() async throws {
        let client = ConfigResourceClient()
        let provider = DaemonRecoveryConfigProvider(clientProvider: { client }, logger: ConfigResourceLogger())
        XCTAssertEqual(client.reads.count, 0)
        let read = Task { await provider.isRecoveryEnabled() }
        try await client.reads.wait(for: 1)
        client.reply(MCPResourceResponse(text: #"{"enabled":false,"config":{"maxToolCalls":9}}"#))
        let enabled = await read.value
        let maximum = await provider.maxRecoveryToolCalls()
        XCTAssertFalse(enabled)
        XCTAssertEqual(maximum, 9)
        XCTAssertEqual(client.reads.count, 1)
        XCTAssertEqual(client.initializations.count, 1)
    }

    func testConcurrentLookupsShareOneResourceRead() async throws {
        let client = ConfigResourceClient()
        let provider = DaemonRecoveryConfigProvider(clientProvider: { client }, logger: ConfigResourceLogger())
        let first = Task { await provider.isRecoveryEnabled() }
        try await client.reads.wait(for: 1)
        let second = Task { await provider.maxRecoveryToolCalls() }
        client.reply(MCPResourceResponse(text: #"{"enabled":true,"config":{"maxToolCalls":7}}"#))
        let enabled = await first.value
        let maximum = await second.value
        XCTAssertTrue(enabled)
        XCTAssertEqual(maximum, 7)
        XCTAssertEqual(client.reads.count, 1)
    }

    func testCancelledLookupDoesNotCacheFallback() async throws {
        let client = ConfigResourceClient()
        let provider = DaemonRecoveryConfigProvider(clientProvider: { client }, logger: ConfigResourceLogger())
        let first = Task { await provider.isRecoveryEnabled() }
        try await client.reads.wait(for: 1)
        first.cancel()
        let fallback = await first.value
        XCTAssertTrue(fallback, "nonthrowing config seam retains its documented fallback")
        let second = Task { await provider.isRecoveryEnabled() }
        try await client.reads.wait(for: 2)
        client.reply(MCPResourceResponse(text: #"{"enabled":false}"#))
        let enabled = await second.value
        XCTAssertFalse(enabled, "cancellation must not memoize enabled=true")
        XCTAssertEqual(client.reads.count, 2)
    }

    func testFailedNonCancelledReadCachesFallbackForProviderLifetime() async throws {
        let client = ConfigResourceClient()
        let provider = DaemonRecoveryConfigProvider(clientProvider: { client }, logger: ConfigResourceLogger())
        let read = Task { await provider.isRecoveryEnabled() }
        try await client.reads.wait(for: 1)
        client.fail(MCPClientError.requestFailed("unreadable config"))
        let enabled = await read.value
        let maximum = await provider.maxRecoveryToolCalls()
        let cachedEnabled = await provider.isRecoveryEnabled()
        XCTAssertTrue(enabled)
        XCTAssertTrue(cachedEnabled)
        XCTAssertEqual(maximum, 5)
        XCTAssertEqual(client.reads.count, 1, "a failed read caches defaults, matching the base behavior")
        XCTAssertEqual(client.initializations.count, 1)
    }
}

private struct ConfigResourceLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

private final class ConfigResourceClient: AutoMobileMCPClient {
    let initializations = TransportEvents()
    let reads = TransportEvents()
    private let responses = OSAllocatedUnfairLock<[SingleResumeCell<MCPResourceResponse>]>(initialState: [])

    func reply(_ response: MCPResourceResponse) {
        let pending = responses.withLock { $0 }
        for cell in pending {
            cell.resume(returning: response)
        }
    }

    func fail(_ error: any Error) {
        let pending = responses.withLock { $0 }
        for cell in pending {
            cell.resume(throwing: error)
        }
    }

    func initialize(timeout _: TimeInterval) async throws {
        try Task.checkCancellation()
        initializations.signal()
    }

    func readResource(uri: String, timeout _: TimeInterval) async throws -> MCPResourceResponse {
        XCTAssertEqual(uri, DaemonRecoveryConfigProvider.resourceURI)
        let cell = SingleResumeCell<MCPResourceResponse>()
        responses.withLock { $0.append(cell) }
        reads.signal()
        return try await cell.wait()
    }

    func callTool(name _: String, arguments _: [String: Any], timeout _: TimeInterval) async throws -> MCPToolResponse {
        XCTFail("Config lookup must not call a device tool")
        throw MCPClientError.requestFailed("unexpected tool")
    }

    func initialize(timeout _: TimeInterval) throws { XCTFail("Unexpected synchronous initialize") }
    func readResource(uri _: String, timeout _: TimeInterval) throws -> MCPResourceResponse {
        XCTFail("Unexpected synchronous resource read")
        throw MCPClientError.requestFailed("unexpected sync resource")
    }

    func callTool(name _: String, arguments _: [String: Any], timeout _: TimeInterval) throws -> MCPToolResponse {
        XCTFail("Unexpected synchronous tool call")
        throw MCPClientError.requestFailed("unexpected sync tool")
    }

    func resetSession() {}
}
