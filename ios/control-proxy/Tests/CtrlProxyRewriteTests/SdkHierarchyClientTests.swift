@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// Behavior tests for the async `SdkHierarchyClient` (Phase 3). The reference client
/// could only be driven against a live socket, so these are rewrite-only tests over the
/// injectable `HTTPRequesting` seam that pin the reference's documented contract: the
/// `DispatchSemaphore.wait` → `await` translation preserves the exact status-code
/// handling (200-only for GETs, HTTP-response-presence classification for highlights)
/// and the swallow-to-nil-on-error behavior.
final class SdkHierarchyClientTests: XCTestCase {
    private let baseURL = URL(string: "http://localhost:8766")!

    private func makeClient(_ main: StubHTTPTransport, health: StubHTTPTransport? = nil) -> SdkHierarchyClient {
        SdkHierarchyClient(baseURL: baseURL, transport: main, healthTransport: health ?? main)
    }

    private static let hierarchyJSON = Data(
        #"{"timestamp":7,"bundleId":"com.example.app","screenScale":3.0,"screenWidth":393,"screenHeight":852}"#.utf8
    )

    // MARK: - GET /hierarchy[/fresh]

    func testFetchHierarchyDecodesOn200AndHitsCorrectPath() async {
        let stub = StubHTTPTransport(status: 200, body: Self.hierarchyJSON)
        let hierarchy = await makeClient(stub).fetchHierarchy()
        XCTAssertEqual(hierarchy?.bundleId, "com.example.app")
        XCTAssertEqual(hierarchy?.timestamp, 7)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/hierarchy")
    }

    func testFetchFreshHierarchyHitsFreshPath() async {
        let stub = StubHTTPTransport(status: 200, body: Self.hierarchyJSON)
        _ = await makeClient(stub).fetchFreshHierarchy()
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/hierarchy/fresh")
    }

    func testFetchHierarchyNilOnNon200() async {
        let hierarchy = await makeClient(StubHTTPTransport(status: 404, body: Self.hierarchyJSON)).fetchHierarchy()
        XCTAssertNil(hierarchy, "non-200 must not decode a body")
    }

    func testFetchHierarchyNilOnTransportError() async {
        let hierarchy = await makeClient(StubHTTPTransport([.transportError])).fetchHierarchy()
        XCTAssertNil(hierarchy)
    }

    func testFetchHierarchyNilOnGarbageBody() async {
        let hierarchy = await makeClient(StubHTTPTransport(status: 200, body: Data("not json".utf8))).fetchHierarchy()
        XCTAssertNil(hierarchy)
    }

    // MARK: - /health routing + availability

    func testFetchServerInfoUsesHealthTransportOnly() async {
        let health = StubHTTPTransport(
            status: 200,
            body: Data(#"{"status":"ok","bundleId":"com.example.app","capabilities":["hierarchy"]}"#.utf8)
        )
        let main = StubHTTPTransport([.nonHTTPResponse])
        let info = await makeClient(main, health: health).fetchServerInfo()
        XCTAssertEqual(info?.bundleId, "com.example.app")
        XCTAssertEqual(health.recordedRequests.first?.url?.path, "/health")
        XCTAssertTrue(main.recordedRequests.isEmpty, "server info must route to the health transport only")
    }

    func testIsAvailableReflectsHealth() async {
        let available = StubHTTPTransport(status: 200, body: Data(#"{"status":"ok","bundleId":null,"capabilities":[]}"#.utf8))
        let unavailable = StubHTTPTransport([.transportError])
        let okClient = await makeClient(unavailable, health: available).isAvailable()
        let downClient = await makeClient(available, health: unavailable).isAvailable()
        XCTAssertTrue(okClient)
        XCTAssertFalse(downClient)
    }

    // MARK: - Network mutations

    func testSetMockRulesTrueOn200WithPostBody() async throws {
        let stub = StubHTTPTransport(status: 200)
        let rule = NetworkMockRuleDTO(
            mockId: "m1", host: "example.com", path: "/x", method: "GET",
            limit: nil, remaining: nil, statusCode: 200, responseHeaders: [:],
            responseBody: "{}", contentType: "application/json"
        )
        let ok = await makeClient(stub).setMockRules([rule])
        XCTAssertTrue(ok)

        let request = try XCTUnwrap(stub.recordedRequests.first)
        XCTAssertEqual(request.url?.path, "/network/mock")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual((json["rules"] as? [Any])?.count, 1)
    }

    func testSetMockRulesFalseOnNon200() async {
        let ok = await makeClient(StubHTTPTransport(status: 500)).setMockRules([])
        XCTAssertFalse(ok)
    }

    func testSetNetworkErrorSimulationHitsPath() async {
        let stub = StubHTTPTransport(status: 200)
        let ok = await makeClient(stub)
            .setNetworkErrorSimulation(NetworkErrorSimulationDTO(enabled: true, errorType: "timeout", limit: 1, expiresAtEpochMs: nil))
        XCTAssertTrue(ok)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/network/error-simulation")
    }

    func testSetNetworkFaultRulesFalseOnTransportError() async {
        let ok = await makeClient(StubHTTPTransport([.transportError])).setNetworkFaultRules([])
        XCTAssertFalse(ok)
    }

    // MARK: - addHighlight outcome classification

    func testAddHighlightRenderedOn200() async {
        let outcome = await makeClient(StubHTTPTransport(status: 200)).addHighlight(id: "h", shape: Self.boxShape)
        XCTAssertEqual(outcome, .rendered)
    }

    func testAddHighlightRejectedOnNon200() async {
        let outcome = await makeClient(StubHTTPTransport(status: 422)).addHighlight(id: "h", shape: Self.boxShape)
        XCTAssertEqual(outcome, .rejected)
    }

    func testAddHighlightUnavailableOnNonHTTP() async {
        let outcome = await makeClient(StubHTTPTransport([.nonHTTPResponse])).addHighlight(id: "h", shape: Self.boxShape)
        XCTAssertEqual(outcome, .unavailable)
    }

    func testAddHighlightUnavailableOnTransportError() async {
        let outcome = await makeClient(StubHTTPTransport([.transportError])).addHighlight(id: "h", shape: Self.boxShape)
        XCTAssertEqual(outcome, .unavailable)
    }

    private static let boxShape = HighlightShape(
        type: "box",
        bounds: HighlightBounds(x: 0, y: 0, width: 10, height: 10),
        points: nil,
        style: nil
    )
}
