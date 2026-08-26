import Foundation
import XCTest

/// Differential parity for the response-envelope models the networking layer emits
/// (rewrite Phase 2 foothold): `WebSocketResponse`, `ConnectedEvent`,
/// `HierarchyUpdateResponse`, and the `buildErrorResponseData` error builder.
final class ResponseModelParityTests: XCTestCase {
    /// Parse JSON to a dictionary with `timestamp` removed, for comparing responses
    /// whose builders stamp a live `Date()` timestamp.
    private func normalized(_ data: Data, file: StaticString = #filePath, line: UInt = #line) -> NSDictionary? {
        guard var dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            XCTFail("not a JSON object: \(String(decoding: data, as: UTF8.self))", file: file, line: line)
            return nil
        }
        dict.removeValue(forKey: "timestamp")
        return dict as NSDictionary
    }

    // MARK: - connected handshake (supportedCommands parity)

    func testConnectedEventMatches() {
        for id in [0, 1, 42] {
            XCTAssertEqual(
                ReferenceResponses.connectedSupportedCommands(id: id),
                RewriteResponses.connectedSupportedCommands(id: id),
                "supportedCommands differ — RequestType.allCases diverged"
            )
            XCTAssertEqual(
                ReferenceResponses.connectedEventEncoded(id: id),
                RewriteResponses.connectedEventEncoded(id: id),
                "connected event bytes differ for id=\(id)"
            )
        }
        // Sanity: the command list is non-empty and sorted (the runner-version signal).
        let commands = RewriteResponses.connectedSupportedCommands(id: 0)
        XCTAssertFalse(commands.isEmpty)
        XCTAssertEqual(commands, commands.sorted())
    }

    // MARK: - WebSocketResponse Codable round-trip

    func testWebSocketResponseReencodesIdentically() throws {
        let golden = Data("""
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
        """.utf8)
        XCTAssertEqual(
            try ReferenceResponses.reencodeWebSocketResponse(golden),
            try RewriteResponses.reencodeWebSocketResponse(golden),
            "WebSocketResponse re-encode diverged"
        )
    }

    func testHierarchyUpdateReencodesIdentically() throws {
        let golden = Data("""
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
        """.utf8)
        XCTAssertEqual(
            try ReferenceResponses.reencodeHierarchyUpdate(golden),
            try RewriteResponses.reencodeHierarchyUpdate(golden),
            "HierarchyUpdateResponse re-encode diverged"
        )
    }

    // MARK: - Error response builder

    func testBuildErrorResponseMatches() {
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
                error: DecodingError.typeMismatch(
                    Int.self,
                    .init(codingPath: [], debugDescription: "Expected Int")
                )
            ),
        ]
        for (i, c) in cases.enumerated() {
            let reference = normalized(ReferenceResponses.buildErrorResponse(requestId: c.requestId, error: c.error))
            let rewrite = normalized(RewriteResponses.buildErrorResponse(requestId: c.requestId, error: c.error))
            XCTAssertEqual(reference, rewrite, "error response[\(i)] diverged (timestamp-normalized)")
            // Shape sanity on the rewrite side.
            XCTAssertEqual(rewrite?["type"] as? String, "error")
            XCTAssertEqual(rewrite?["success"] as? Bool, false)
        }
    }
}
