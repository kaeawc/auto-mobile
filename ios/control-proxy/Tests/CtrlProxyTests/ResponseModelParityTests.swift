@testable import CtrlProxy
import Foundation
import XCTest

final class ResponseModelParityTests: XCTestCase {
    // MARK: - connected handshake (supportedCommands is the runner-version signal)

    func testConnectedEventMatches() {
        // The handler's runtime-capable command list is non-empty and sorted.
        let commands = Responses.connectedSupportedCommands(id: 0)
        XCTAssertFalse(commands.isEmpty)
        XCTAssertEqual(commands, commands.sorted())
        // The encoded connected event is a valid JSON object carrying that command list.
        let encoded = Responses.connectedEventEncoded(id: 42)
        guard let object = JSONGolden.object(encoded) else { return }
        XCTAssertEqual(object["supportedCommands"] as? [String], commands)
        XCTAssertTrue(commands.contains("get_sdk_capabilities"))
        // The handshake also advertises optional runner features (RunnerFeature.allCases,
        // sorted); the daemon reads it to gate feature use, so `display_cutout_info` is a
        // load-bearing wire identifier (#5787).
        XCTAssertEqual(
            object["supportedFeatures"] as? [String],
            ["display_cutout_info", "double_tap_v1", "path_gesture_v1"]
        )
    }

    func testSdkCapabilitiesResponseDistinguishesRunnerSupportFromForegroundSdkAvailability() {
        let response = SdkCapabilitiesResponse(
            requestId: "sdk-1",
            available: false,
            bundleId: nil,
            capabilities: [],
            totalTimeMs: 1
        )
        let encoded = (try? JSONEncoder().encode(response)) ?? Data()
        guard let object = JSONGolden.object(encoded) else { return }
        XCTAssertEqual(object["type"] as? String, "sdk_capabilities_result")
        XCTAssertEqual(object["success"] as? Bool, true)
        XCTAssertEqual(object["available"] as? Bool, false)
        XCTAssertEqual(object["capabilities"] as? [String], [])
    }

    // MARK: - WebSocketResponse / HierarchyUpdate Codable round-trip

    func testWebSocketResponseReencodesFaithfully() {
        JSONGolden.assertReencodePreservesWire(
            Responses.reencodeWebSocketResponse,
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
            Responses.reencodeHierarchyUpdate,
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
        for (i, testCase) in cases.enumerated() {
            guard let object = JSONGolden.object(
                Responses.buildErrorResponse(requestId: testCase.requestId, error: testCase.error),
                strippingTimestamp: true
            ) else { continue }
            XCTAssertEqual(object["type"] as? String, "error", "error response[\(i)] type")
            XCTAssertEqual(object["success"] as? Bool, false, "error response[\(i)] success")
            XCTAssertFalse((object["error"] as? String ?? "").isEmpty, "error response[\(i)] error text")
            if let expectedId = testCase.requestId {
                XCTAssertEqual(object["requestId"] as? String, expectedId, "error response[\(i)] requestId")
            }
        }
    }
}
