import Foundation
import XCTest
@testable import XCTestRunner

@MainActor
final class AsyncProtocolWitnessTests: XCTestCase {
    func testAsyncWitnessReturnsValuesAndPropagatesErrors() async throws {
        let client: any AutoMobileMCPClient = AsyncProtocolTransport()
        try await client.initialize(timeout: 1)
        let tool = try await client.callTool(name: "observe", arguments: [:], timeout: 1)
        let resource = try await client.readResource(uri: "test", timeout: 1)
        XCTAssertEqual(tool.text, "tool value")
        XCTAssertEqual(resource.text, "resource value")

        let failing: any AutoMobileMCPClient = AsyncProtocolTransport(failure: .sessionExpired)
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

/// Native async witnesses exercise the Sendable existential transport contract.
private struct AsyncProtocolTransport: AutoMobileMCPClient {
    var failure: MCPClientError?

    func initialize(timeout _: TimeInterval) async throws {
        if let failure { throw failure }
    }

    func callTool(name _: String, arguments _: [String: Any], timeout _: TimeInterval) async throws -> MCPToolResponse {
        if let failure { throw failure }
        return MCPToolResponse(text: "tool value")
    }

    func readResource(uri _: String, timeout _: TimeInterval) async throws -> MCPResourceResponse {
        if let failure { throw failure }
        return MCPResourceResponse(text: "resource value")
    }

    func resetSession() {}
}
