import Foundation
import XCTest

/// Wire-contract tests for the response-envelope models the networking layer emits:
/// `WebSocketResponse`, `ConnectedEvent`, `HierarchyUpdateResponse`, and `ErrorResponse.build`.
///
/// Phase-7E re-anchor: was differential (byte/object-diff of reference vs rewrite). With the
/// reference retired it is reference-free — `JSONGolden` idempotence + wire-field containment
/// for the Codable round-trips, and direct shape/sanity assertions for the connected handshake
/// and the error builder.
final class ResponseModelParityTests: XCTestCase {
    // MARK: - connected handshake (supportedCommands is the runner-version signal)

    func testConnectedEventMatches() {
        // The command list is non-empty and sorted (RequestType.allCases, sorted).
        let commands = RewriteResponses.connectedSupportedCommands(id: 0)
        XCTAssertFalse(commands.isEmpty)
        XCTAssertEqual(commands, commands.sorted())
        // The encoded connected event is a valid JSON object carrying that command list.
        let encoded = RewriteResponses.connectedEventEncoded(id: 42)
        guard let object = JSONGolden.object(encoded) else { return }
        XCTAssertEqual(object["supportedCommands"] as? [String], commands)
        // The handshake also advertises optional runner features (RunnerFeature.allCases,
        // sorted); the daemon reads it to gate feature use, so `display_cutout_info` is a
        // load-bearing wire identifier (#5787).
        XCTAssertEqual(object["supportedFeatures"] as? [String], ["display_cutout_info"])
    }

    // MARK: - WebSocketResponse / HierarchyUpdate Codable round-trip

    func testWebSocketResponseReencodesFaithfully() {
        JSONGolden.assertReencodePreservesWire(
            RewriteResponses.reencodeWebSocketResponse,
            input: """
            {
              "type": "tap_coordinates_result",
              "timestamp": 1730000000000,
              "requestId": "r1",
              "success": true,
              "totalTimeMs": 42,
              "text": "ok",
              "perfTiming": { "name": "root", "durationMs": 10,
                              "children": [ { "name": "child", "durationMs": 3 } ] },
              "pinchPath": "event-path"
            }
            """,
            "WebSocketResponse"
        )
    }

    func testHierarchyUpdateReencodesFaithfully() {
        JSONGolden.assertReencodePreservesWire(
            RewriteResponses.reencodeHierarchyUpdate,
            input: """
            {
              "type": "hierarchy_update",
              "timestamp": 1730000000000,
              "requestId": "r2",
              "data": {
                "updatedAt": 1,
                "packageName": "com.example.app",
                "insets": { "available": false, "source": "unavailable", "units": "unknown" }
              },
              "perfTiming": { "name": "root", "durationMs": 5 },
              "frameContext": "epoch:1:abc123"
            }
            """,
            "HierarchyUpdateResponse"
        )
    }

    // MARK: - Error response builder (shape; live-Date timestamp stripped)

    func testBuildErrorResponseShape() {
        struct Case { let requestId: String?; let error: Error }
        let cases: [Case] = [
            Case(requestId: "abc", error: NSError(domain: "t", code: 1, userInfo: [NSLocalizedDescriptionKey: "boom"])),
            Case(requestId: nil, error: NSError(domain: "t", code: 2, userInfo: [NSLocalizedDescriptionKey: "no id"])),
            Case(
                requestId: "with\"quote\\backslash",
                error: NSError(domain: "t", code: 3, userInfo: [NSLocalizedDescriptionKey: "special chars"])
            ),
            Case(
                requestId: "typed",
                error: DecodingError.typeMismatch(Int.self, .init(codingPath: [], debugDescription: "Expected Int"))
            ),
        ]
        for (i, c) in cases.enumerated() {
            guard let object = JSONGolden.object(
                RewriteResponses.buildErrorResponse(requestId: c.requestId, error: c.error),
                strippingTimestamp: true
            ) else { continue }
            XCTAssertEqual(object["type"] as? String, "error", "error response[\(i)] type")
            XCTAssertEqual(object["success"] as? Bool, false, "error response[\(i)] success")
            XCTAssertFalse((object["error"] as? String ?? "").isEmpty, "error response[\(i)] error text")
            if let expectedId = c.requestId {
                XCTAssertEqual(object["requestId"] as? String, expectedId, "error response[\(i)] requestId")
            }
        }
    }
}
