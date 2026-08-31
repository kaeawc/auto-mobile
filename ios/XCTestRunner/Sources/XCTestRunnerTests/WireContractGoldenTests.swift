import Foundation
import XCTest
@testable import XCTestRunner

/// Golden locks on the frozen P0 request wires, asserted on the pure encoders extracted during the
/// rewrite (the reference built these dicts inline). Compared structurally (parsed JSON), NOT
/// byte-for-byte, since production `JSONSerialization` emits unspecified key order. The behavioral
/// coverage of the executor/recovery/version/timing lives in the adapted suites alongside this file.
final class WireContractGoldenTests: XCTestCase {
    func testDaemonReleaseSessionRequestLine() throws {
        let line = try XCTUnwrap(DaemonManager.buildDaemonRequestLine(
            id: "fixed-id",
            method: "daemon/releaseSession",
            params: ["sessionId": "sess-1"],
            clientVersion: "0.0.67"
        ))
        XCTAssertTrue(line.hasSuffix("\n"))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["id", "type", "method", "params", "clientVersion"])
        XCTAssertEqual(object["type"] as? String, "daemon_request")
        XCTAssertEqual(object["method"] as? String, "daemon/releaseSession")
        XCTAssertEqual(object["clientVersion"] as? String, "0.0.67")
        XCTAssertEqual((object["params"] as? [String: Any])?["sessionId"] as? String, "sess-1")
    }

    func testDaemonRefreshDevicesRequestLine() throws {
        let line = try XCTUnwrap(DaemonManager.buildDaemonRequestLine(
            id: "fixed-id", method: "daemon/refreshDevices", params: [:], clientVersion: "0.0.67"
        ))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(object["method"] as? String, "daemon/refreshDevices")
        XCTAssertEqual((object["params"] as? [String: Any])?.isEmpty, true)
    }

    func testDaemonSocketMCPRequestLine() throws {
        let line = try XCTUnwrap(AutoMobileDaemonClient.encodeRequestLine(
            id: "5", method: "tools/call",
            params: ["name": "executePlan", "arguments": ["sessionUuid": "s1"]],
            timeoutMs: 300_000, clientVersion: "0.0.67"
        ))
        XCTAssertEqual(line.last, 0x0A)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["id", "type", "method", "params", "timeoutMs", "clientVersion"])
        XCTAssertEqual(object["id"] as? String, "5")
        XCTAssertEqual(object["type"] as? String, "mcp_request")
        XCTAssertEqual(object["timeoutMs"] as? Int, 300_000)
    }

    func testStreamableJSONRPCBody() throws {
        let data = try XCTUnwrap(StreamableHTTPMCPClient.encodeJSONRPCBody(
            id: 1, method: "tools/call", params: ["name": "observe"]
        ))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["jsonrpc", "id", "method", "params"])
        XCTAssertEqual(object["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(object["id"] as? Int, 1)
    }

    func testStreamableInitializeParams() throws {
        let params = StreamableHTTPMCPClient.initializeParams()
        XCTAssertEqual(params["protocolVersion"] as? String, "2024-11-05")
        let clientInfo = try XCTUnwrap(params["clientInfo"] as? [String: Any])
        XCTAssertEqual(clientInfo["name"] as? String, "auto-mobile-xctest-runner")
        XCTAssertEqual(clientInfo["version"] as? String, AutoMobileVersion.current)
    }
}
