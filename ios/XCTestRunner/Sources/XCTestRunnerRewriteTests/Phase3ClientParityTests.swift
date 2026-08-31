import Foundation
import XCTest

// Phase-3: stateful transport clients. The frozen request wires are locked with structural-JSON
// goldens on the extracted encoders; endpoint validation is diffed against the reference; the
// FailingMCPClient null-object is behavior-checked.
@testable import XCTestRunner
@testable import XCTestRunnerRewrite

final class Phase3ClientParityTests: XCTestCase {
    // MARK: - Daemon-socket mcp_request wire (P0)

    func testDaemonRequestLineWireContract() throws {
        let line = try XCTUnwrap(XCTestRunnerRewrite.AutoMobileDaemonClient.encodeRequestLine(
            id: "5",
            method: "tools/call",
            params: ["name": "executePlan", "arguments": ["sessionUuid": "s1"]],
            timeoutMs: 300_000,
            clientVersion: "0.0.67"
        ))
        XCTAssertEqual(line.last, 0x0A, "frozen framing: trailing newline")
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["id", "type", "method", "params", "timeoutMs", "clientVersion"])
        XCTAssertEqual(object["id"] as? String, "5", "id is the stringified request counter")
        XCTAssertEqual(object["type"] as? String, "mcp_request")
        XCTAssertEqual(object["method"] as? String, "tools/call")
        XCTAssertEqual(object["timeoutMs"] as? Int, 300_000)
        XCTAssertEqual(object["clientVersion"] as? String, "0.0.67")
        let params = try XCTUnwrap(object["params"] as? [String: Any])
        XCTAssertEqual(params["name"] as? String, "executePlan")
    }

    // MARK: - StreamableHTTP JSON-RPC 2.0 wire

    func testStreamableJSONRPCBodyWireContract() throws {
        let data = try XCTUnwrap(XCTestRunnerRewrite.StreamableHTTPMCPClient.encodeJSONRPCBody(
            id: 1,
            method: "tools/call",
            params: ["name": "observe"]
        ))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["jsonrpc", "id", "method", "params"])
        XCTAssertEqual(object["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(object["id"] as? Int, 1, "JSON-RPC id is a number (not stringified)")
        XCTAssertEqual(object["method"] as? String, "tools/call")
    }

    func testStreamableInitializeParamsContract() throws {
        let params = XCTestRunnerRewrite.StreamableHTTPMCPClient.initializeParams()
        XCTAssertEqual(params["protocolVersion"] as? String, "2024-11-05")
        let clientInfo = try XCTUnwrap(params["clientInfo"] as? [String: Any])
        XCTAssertEqual(clientInfo["name"] as? String, "auto-mobile-xctest-runner", "name-sensitive wire contract")
        XCTAssertEqual(clientInfo["version"] as? String, XCTestRunnerRewrite.AutoMobileVersion.current)
    }

    // MARK: - Endpoint validation parity

    func testStreamableEndpointValidationParity() {
        let schemeless = URL(string: "relative/path")!
        XCTAssertNil(schemeless.scheme)
        XCTAssertThrowsError(try XCTestRunner.StreamableHTTPMCPClient(endpoint: schemeless))
        XCTAssertThrowsError(try XCTestRunnerRewrite.StreamableHTTPMCPClient(endpoint: schemeless))

        let valid = URL(string: "http://localhost:9000/auto-mobile/streamable")!
        XCTAssertNoThrow(try XCTestRunner.StreamableHTTPMCPClient(endpoint: valid))
        XCTAssertNoThrow(try XCTestRunnerRewrite.StreamableHTTPMCPClient(endpoint: valid))
    }

    // MARK: - FailingMCPClient null-object

    func testFailingMCPClientRethrowsStoredError() {
        let client = XCTestRunnerRewrite.FailingMCPClient(error: XCTestRunnerRewrite.MCPClientError.serverError("boom"))
        XCTAssertThrowsError(try client.initialize(timeout: 1))
        XCTAssertThrowsError(try client.callTool(name: "x", arguments: [:], timeout: 1)) { error in
            XCTAssertEqual(error as? XCTestRunnerRewrite.MCPClientError, .serverError("boom"))
        }
        XCTAssertThrowsError(try client.readResource(uri: "x", timeout: 1))
        client.resetSession()  // no-op, must not crash
    }
}
