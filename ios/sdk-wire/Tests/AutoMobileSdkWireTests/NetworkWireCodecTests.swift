@testable import AutoMobileSdkWire
import Foundation
import XCTest

/// The mock and fault rule bodies the runner re-encodes for the SDK's `/network/*` routes. The JSON
/// literals are the field names the host sends (see `NetworkMockRuleDTO`'s consumers in the SDK).
final class NetworkWireCodecTests: XCTestCase {
    private func canonical(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testMockRulesBodyRoundTripsTheHostShape() throws {
        let json = #"""
        {"rules":[{"mockId":"m1","host":"api\\.example\\.com","path":"/v1/.*","method":"GET","limit":2,
         "remaining":null,"statusCode":201,"responseHeaders":{"X-A":"b"},"responseBody":"{}",
         "contentType":"application/json"}]}
        """#
        let body = try JSONDecoder().decode(SetMockRulesBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.rules.first?.mockId, "m1")
        XCTAssertEqual(body.rules.first?.limit, 2)
        XCTAssertNil(body.rules.first?.remaining)
        XCTAssertEqual(
            try JSONDecoder().decode(SetMockRulesBody.self, from: JSONEncoder().encode(body)).rules,
            body.rules
        )
    }

    func testFaultRulesBodyKeepsTypedTransportAndActionOnTheWire() throws {
        let json = #"""
        {"rules":[{"faultId":"f1","transport":"urlSession","host":"h","action":"latency","delayMs":250,
         "dryRun":false},{"faultId":"f2","action":"closeConnection","transport":"webSocket","dryRun":true,
         "expiresAtEpochMs":1789000000000}]}
        """#
        let body = try JSONDecoder().decode(SetNetworkFaultRulesBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.rules.map(\.action), [.latency, .closeConnection])
        XCTAssertEqual(body.rules.map(\.transport), [.urlSession, .webSocket])
        XCTAssertEqual(body.rules[1].expiresAtEpochMs, 1_789_000_000_000)
        let encoded = try object(canonical(body))
        let rules = try XCTUnwrap(encoded["rules"] as? [[String: Any]])
        XCTAssertEqual(rules[0]["action"] as? String, "latency")
        XCTAssertEqual(rules[1]["transport"] as? String, "webSocket")
    }

    func testAnUnknownFaultActionIsADecodingError() {
        let json = #"{"rules":[{"faultId":"f","action":"teleport","dryRun":false}]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(SetNetworkFaultRulesBody.self, from: Data(json.utf8)))
    }

    func testErrorSimulationPrefersTheDeviceClockRemainder() throws {
        let simulation = try JSONDecoder().decode(
            NetworkErrorSimulationDTO.self,
            from: Data(#"{"enabled":true,"errorType":"timeout","limit":3,"expiresAtEpochMs":5,"remainingMs":900}"#.utf8)
        )
        XCTAssertEqual(simulation.remainingMs, 900)
        let older = try JSONDecoder().decode(
            NetworkErrorSimulationDTO.self, from: Data(#"{"enabled":false}"#.utf8)
        )
        XCTAssertFalse(older.enabled)
        XCTAssertNil(older.remainingMs)
    }

    func testTheMockReplyKeepsRejectedRulesAndToleratesAnOlderSdk() throws {
        let reply = try JSONDecoder().decode(
            SetMockRulesReply.self,
            from: Data(#"{"status":"ok","rejected":[{"mockId":"bad","reason":"invalid regex"}]}"#.utf8)
        )
        XCTAssertEqual(reply.rejected, [RejectedMockRule(mockId: "bad", reason: "invalid regex")])
        XCTAssertNil(try JSONDecoder().decode(SetMockRulesReply.self, from: Data(#"{"status":"ok"}"#.utf8)).rejected)
    }
}
