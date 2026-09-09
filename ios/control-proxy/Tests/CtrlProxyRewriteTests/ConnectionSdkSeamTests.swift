@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// End-to-end tests that the `WebSocketConnection` HTTP endpoints invoke the Phase-3 SDK
/// seams: `POST /sdk-events` forwards the batch body to `onSdkEventBatch` (wired here to
/// `SdkHierarchyExtractor` + a real `SdkHierarchyCache`), and `GET /sdk-events` merges the
/// `drainLogEvents` output into its response. This "fills" the seams the connection left
/// open in Phase 2; the production wiring (via the coordinator) lands in Phase 6.
final class ConnectionSdkSeamTests: XCTestCase {
    private func httpRequest(method: String, path: String, body: Data = Data()) -> Data {
        var head = "\(method) \(path) HTTP/1.1\r\nHost: localhost:8765\r\n"
        if !body.isEmpty {
            head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n"
        }
        head += "\r\n"
        return Data(head.utf8) + body
    }

    private func hierarchyBatch(bundleId: String) -> Data {
        let payloadJSON = """
        {"hierarchy":{"timestamp":11,"bundleId":"\(bundleId)","screenScale":3,"screenWidth":393,"screenHeight":852}}
        """
        let payloadBase64 = Data(payloadJSON.utf8).base64EncodedString()
        return Data(#"{"bundleId":null,"events":[{"eventType":"view_hierarchy","payload":"\#(payloadBase64)"}]}"#.utf8)
    }

    func testPostSdkEventsInvokesSeamAndExtractsHierarchy() {
        let cache = SdkHierarchyCache()
        let batch = hierarchyBatch(bundleId: "com.example.app")
        let request = httpRequest(method: "POST", path: "/sdk-events", body: batch)

        let recorder = RewriteConnectionDriver.run(
            inbound: request,
            onSdkEventBatch: { data in SdkHierarchyExtractor.extractIfPresent(from: data, into: cache) }
        )

        // The seam ran the extractor, which decoded the batch and cached the hierarchy.
        XCTAssertEqual(cache.latest?.bundleId, "com.example.app")
        XCTAssertEqual(cache.latest?.timestamp, 11)
        // The endpoint still returns its 200 acknowledgement.
        let response = recorder.sends.map { String(decoding: $0, as: UTF8.self) }.joined()
        XCTAssertTrue(response.contains("200 OK"), "POST /sdk-events should acknowledge with 200")
        XCTAssertTrue(response.contains(#"{"ok":true}"#))
    }

    func testGetSdkEventsMergesDrainLogEventsIntoResponse() {
        // Isolate from any batch a prior test left in the shared buffer.
        _ = SdkEventBuffer.shared.drain()
        let logEvent = Data(#"{"eventType":"log","level":2,"message":"hi"}"#.utf8)
        let request = httpRequest(method: "GET", path: "/sdk-events")

        let recorder = RewriteConnectionDriver.run(
            inbound: request,
            drainLogEvents: { [logEvent] }
        )

        let response = recorder.sends.map { String(decoding: $0, as: UTF8.self) }.joined()
        XCTAssertTrue(
            response.contains(#"{"eventType":"log","level":2,"message":"hi"}"#),
            "GET /sdk-events must include the drainLogEvents output; got:\n\(response)"
        )
    }
}
