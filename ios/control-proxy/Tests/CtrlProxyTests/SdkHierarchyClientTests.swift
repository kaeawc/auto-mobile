@testable import CtrlProxy
import Foundation
import XCTest

// Test fixtures fail-fast on malformed setup data, so force-unwrap is idiomatic here
// (blanket-allowed for force_unwrapping in test targets — see .swiftlint.yml).
// swiftlint:disable force_unwrapping

final class SdkHierarchyClientTests: XCTestCase {
    private let baseURL = URL(string: "http://localhost:8766")!

    private func makeClient(_ main: StubHTTPTransport, health: StubHTTPTransport? = nil) -> SdkHierarchyClient {
        SdkHierarchyClient(baseURL: baseURL, transport: main, healthTransport: health ?? main)
    }

    func testMagicTapPostPreservesHandledFalseAndFailures() async {
        for handled in [true, false] {
            let transport = StubHTTPTransport(status: 200, body: Data("{\"handled\":\(handled)}".utf8))
            let result = await makeClient(transport).performMagicTap()
            XCTAssertEqual(result, handled)
            XCTAssertEqual(transport.recordedRequests.first?.httpMethod, "POST")
            XCTAssertEqual(transport.recordedRequests.first?.url?.path, "/accessibility/magic-tap")
        }
        for outcome in [
            StubOutcome.transportError,
            .respond(status: 404, body: Data()),
            .respond(status: 200, body: Data("{}".utf8)),
        ] {
            let result = await makeClient(StubHTTPTransport([outcome])).performMagicTap()
            XCTAssertNil(result)
        }
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

    func testFreshResultDecodesHierarchyOn200() async {
        let stub = StubHTTPTransport(status: 200, body: Self.hierarchyJSON)
        guard case let .hierarchy(hierarchy) = await makeClient(stub).fetchFreshHierarchyResult() else {
            return XCTFail("Expected decoded hierarchy")
        }
        XCTAssertEqual(hierarchy.bundleId, "com.example.app")
        XCTAssertEqual(hierarchy.timestamp, 7)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/hierarchy/fresh")
    }

    func testFreshResultReportsTimeout() async {
        let result = await makeClient(StubHTTPTransport([.timedOut])).fetchFreshHierarchyResult()
        guard case let .failed(failure) = result else { return XCTFail("Expected timeout failure") }
        XCTAssertEqual(failure, .timedOut)
        XCTAssertEqual(failure.reason, "SDK hierarchy request timed out")
    }

    func testFetchFreshHierarchyNilOnTimeout() async {
        let hierarchy = await makeClient(StubHTTPTransport([.timedOut])).fetchFreshHierarchy()
        XCTAssertNil(hierarchy)
    }

    func testFreshResultIsUnavailableWithoutHTTPResponse() async {
        // transportError throws URLError(.cannotConnectToHost), which remains unavailable.
        for outcome in [StubOutcome.transportError, .connectionLost, .nonHTTPResponse] {
            guard case .unavailable = await makeClient(StubHTTPTransport([outcome])).fetchFreshHierarchyResult() else {
                return XCTFail("Expected unavailable for \(outcome)")
            }
        }
    }

    func testFreshResultReportsNon200Status() async {
        let result = await makeClient(StubHTTPTransport(status: 404, body: Self.hierarchyJSON))
            .fetchFreshHierarchyResult()
        guard case let .failed(failure) = result else { return XCTFail("Expected HTTP failure") }
        XCTAssertEqual(failure, .httpStatus(404))
        XCTAssertTrue(failure.reason.contains("404"))
    }

    func testFreshResultReportsMalformedJSON() async {
        let result = await makeClient(StubHTTPTransport(status: 200, body: Data("not json".utf8)))
            .fetchFreshHierarchyResult()
        guard case let .failed(.undecodable(reason)) = result else { return XCTFail("Expected decoding failure") }
        XCTAssertFalse(reason.isEmpty)
        XCTAssertTrue(reason.contains("dataCorrupted"))
    }

    func testFreshResultReportsMissingRequiredKey() async {
        let body = Data(#"{"bundleId":"com.example.app","screenScale":3,"screenWidth":393,"screenHeight":852}"#.utf8)
        let result = await makeClient(StubHTTPTransport(status: 200, body: body)).fetchFreshHierarchyResult()
        guard case let .failed(.undecodable(reason)) = result else { return XCTFail("Expected decoding failure") }
        XCTAssertTrue(reason.contains("timestamp"), reason)
        XCTAssertTrue(reason.contains("keyNotFound"), reason)
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
        let available = StubHTTPTransport(
            status: 200,
            body: Data(#"{"status":"ok","bundleId":null,"capabilities":[]}"#.utf8)
        )
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

    // MARK: - Network mock rule report (#10101)

    func testPushMockRulesReturnsTheRulesTheSdkRejected() async {
        let body = Data(#"{"status":"ok","rejected":[{"mockId":"m1","reason":"invalid regex: x"}]}"#.utf8)
        let stub = StubHTTPTransport(status: 200, body: body)

        let outcome = await makeClient(stub).pushMockRules([])

        XCTAssertEqual(
            outcome,
            SdkMockRulesOutcome(ok: true, rejectedMockIds: ["m1"], rejectedReasons: ["m1": "invalid regex: x"])
        )
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/network/mock")
        XCTAssertEqual(stub.recordedRequests.first?.httpMethod, "POST")
    }

    func testPushMockRulesTreatsAnEmptyRejectedListAsAReportThatNothingWasRejected() async {
        let stub = StubHTTPTransport(status: 200, body: Data(#"{"status":"ok","rejected":[]}"#.utf8))

        let outcome = await makeClient(stub).pushMockRules([])

        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: true, rejectedMockIds: [], rejectedReasons: [:]))
    }

    func testPushMockRulesHasNoReportFromAnSdkThatPredatesIt() async {
        let stub = StubHTTPTransport(status: 200, body: Data(#"{"status":"ok"}"#.utf8))

        let outcome = await makeClient(stub).pushMockRules([])

        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: true))
        XCTAssertNil(outcome.rejectedMockIds)
    }

    func testPushMockRulesFailsOnNon200() async {
        let outcome = await makeClient(StubHTTPTransport(status: 500)).pushMockRules([])
        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: false))
    }

    func testPushMockRulesFailsOnTransportError() async {
        let outcome = await makeClient(StubHTTPTransport([.transportError])).pushMockRules([])
        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: false))
    }

    func testSetNetworkErrorSimulationHitsPath() async {
        let stub = StubHTTPTransport(status: 200)
        let ok = await makeClient(stub)
            .setNetworkErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "timeout",
                limit: 1,
                expiresAtEpochMs: nil
            ))
        XCTAssertTrue(ok)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/network/error-simulation")
    }

    func testSetNetworkFaultRulesFalseOnTransportError() async {
        let ok = await makeClient(StubHTTPTransport([.transportError])).setNetworkFaultRules([])
        XCTAssertFalse(ok)
    }

    // MARK: - addHighlight outcome classification

    func testAddHighlightRenderedOn200() async {
        let outcome = await makeClient(StubHTTPTransport(status: 200)).addHighlight(id: "h", shape: Self.circleShape)
        XCTAssertEqual(outcome, .rendered)
    }

    func testAddHighlightRejectedOnNon200() async {
        let outcome = await makeClient(StubHTTPTransport(status: 422)).addHighlight(id: "h", shape: Self.circleShape)
        XCTAssertEqual(outcome, .rejected)
    }

    func testAddHighlightUnavailableOnNonHTTP() async {
        let outcome = await makeClient(StubHTTPTransport([.nonHTTPResponse])).addHighlight(
            id: "h",
            shape: Self.circleShape
        )
        XCTAssertEqual(outcome, .unavailable)
    }

    func testAddHighlightUnavailableOnTransportError() async {
        let outcome = await makeClient(StubHTTPTransport([.transportError])).addHighlight(
            id: "h",
            shape: Self.circleShape
        )
        XCTAssertEqual(outcome, .unavailable)
    }

    private static let circleShape = HighlightShape(
        type: .circle,
        bounds: HighlightBounds(x: 0, y: 0, width: 10, height: 10)
    )
}
