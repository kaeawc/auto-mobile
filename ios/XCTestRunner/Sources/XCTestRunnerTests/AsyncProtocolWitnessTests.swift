import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class AsyncProtocolWitnessTests: XCTestCase {
    func testSyncOnlyWitnessReturnsValuesAndPropagatesErrorsThroughAsyncAPI() async throws {
        let client: any AutoMobileMCPClient = SyncOnlyTransport()
        try await client.initialize(timeout: 1)
        let tool = try await client.callTool(name: "observe", arguments: [:], timeout: 1)
        let resource = try await client.readResource(uri: "test", timeout: 1)
        XCTAssertEqual(tool.text, "tool value")
        XCTAssertEqual(resource.text, "resource value")

        let failing: any AutoMobileMCPClient = SyncOnlyTransport(failure: .sessionExpired)
        do {
            try await failing.initialize(timeout: 1)
            XCTFail("Expected initialize error")
        } catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
        do {
            _ = try await failing.callTool(name: "observe", arguments: [:], timeout: 1)
            XCTFail("Expected callTool error")
        } catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
        do {
            _ = try await failing.readResource(uri: "test", timeout: 1)
            XCTFail("Expected readResource error")
        } catch { XCTAssertEqual(error as? MCPClientError, .sessionExpired) }
    }
}

/// Only synchronous witnesses: the async existential API invokes these non-blocking methods.
private struct SyncOnlyTransport: AutoMobileMCPClient {
    var failure: MCPClientError?

    func initialize(timeout _: TimeInterval) throws {
        if let failure { throw failure }
    }

    func callTool(name _: String, arguments _: [String: Any], timeout _: TimeInterval) throws -> MCPToolResponse {
        if let failure { throw failure }
        return MCPToolResponse(text: "tool value")
    }

    func readResource(uri _: String, timeout _: TimeInterval) throws -> MCPResourceResponse {
        if let failure { throw failure }
        return MCPResourceResponse(text: "resource value")
    }

    func resetSession() {}
}
