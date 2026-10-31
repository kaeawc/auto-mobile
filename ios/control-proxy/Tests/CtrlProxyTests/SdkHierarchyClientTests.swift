import AutoMobileSdkWire
@testable import CtrlProxy
import Foundation
import XCTest

final class SdkHierarchyClientTests: XCTestCase {
    private func makeClient(_ main: StubHTTPTransport, health: StubHTTPTransport? = nil) throws -> SdkHierarchyClient {
        try SdkHierarchyClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
            transport: main,
            healthTransport: health ?? main
        )
    }

    func testObservationActionBudgetSetsRequestAndResourceTimeouts() async throws {
        for budgetMs in [12000.0, 13000.0] {
            let main = StubHTTPTransport([])
            let action = StubHTTPTransport(status: 200)
            let client = try SdkHierarchyClient(
                baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
                transport: main, healthTransport: main,
                actionTransport: { configuration in
                    XCTAssertEqual(configuration.timeoutIntervalForRequest, budgetMs / 1000)
                    XCTAssertEqual(configuration.timeoutIntervalForResource, budgetMs / 1000)
                    return action
                }
            )
            let reply = await client.sendObservationRequest(
                .observationAction,
                body: Data("{}".utf8),
                timeoutMs: budgetMs
            )
            XCTAssertEqual(reply?.statusCode, 200)
            XCTAssertEqual(action.recordedRequests.first?.timeoutInterval, budgetMs / 1000)
            XCTAssertEqual(action.recordedRequests.first?.url?.path, SdkRoute.observationAction.path)
            XCTAssertTrue(main.recordedRequests.isEmpty)
        }
    }

    func testObservationWithoutBudgetKeepsDataTimeoutDefaultsAndTransport() async throws {
        let configuration = SdkHierarchyClient.dataConfiguration()
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 2)
        XCTAssertEqual(configuration.timeoutIntervalForResource, 5)
        let main = StubHTTPTransport(status: 200)
        let client = try makeClient(main)
        let reply = await client.sendObservationRequest(.observationSnapshot, body: Data("{}".utf8))
        XCTAssertEqual(reply?.statusCode, 200)
        XCTAssertEqual(main.recordedRequests.count, 1)
    }

    func testMagicTapPostPreservesHandledFalseAndFailures() async throws {
        for handled in [true, false] {
            let transport = StubHTTPTransport(status: 200, body: Data("{\"handled\":\(handled)}".utf8))
            let result = try await makeClient(transport).performMagicTap()
            XCTAssertEqual(result, handled)
            XCTAssertEqual(transport.recordedRequests.first?.httpMethod, "POST")
            XCTAssertEqual(transport.recordedRequests.first?.url?.path, "/accessibility/magic-tap")
        }
        for outcome in [
            StubOutcome.transportError,
            .respond(status: 404, body: Data()),
            .respond(status: 200, body: Data("{}".utf8)),
        ] {
            let result = try await makeClient(StubHTTPTransport([outcome])).performMagicTap()
            XCTAssertNil(result)
        }
    }

    private static let hierarchyJSON = Data(
        #"{"timestamp":7,"bundleId":"com.example.app","screenScale":3.0,"screenWidth":393,"screenHeight":852}"#.utf8
    )

    // MARK: - GET /hierarchy[/fresh]

    func testFetchHierarchyDecodesOn200AndHitsCorrectPath() async throws {
        let stub = StubHTTPTransport(status: 200, body: Self.hierarchyJSON)
        let hierarchy = try await makeClient(stub).fetchHierarchy()
        XCTAssertEqual(hierarchy?.bundleId, "com.example.app")
        XCTAssertEqual(hierarchy?.timestamp, 7)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/hierarchy")
    }

    func testFetchFreshHierarchyHitsFreshPath() async throws {
        let stub = StubHTTPTransport(status: 200, body: Self.hierarchyJSON)
        _ = try await makeClient(stub).fetchFreshHierarchy()
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/hierarchy/fresh")
    }

    func testFetchHierarchyNilOnNon200() async throws {
        let hierarchy = try await makeClient(StubHTTPTransport(status: 404, body: Self.hierarchyJSON)).fetchHierarchy()
        XCTAssertNil(hierarchy, "non-200 must not decode a body")
    }

    func testFetchHierarchyNilOnTransportError() async throws {
        let hierarchy = try await makeClient(StubHTTPTransport([.transportError])).fetchHierarchy()
        XCTAssertNil(hierarchy)
    }

    func testFetchHierarchyNilOnGarbageBody() async throws {
        let hierarchy = try await makeClient(StubHTTPTransport(status: 200, body: Data("not json".utf8)))
            .fetchHierarchy()
        XCTAssertNil(hierarchy)
    }

    func testFreshResultDecodesHierarchyOn200() async throws {
        let stub = StubHTTPTransport(status: 200, body: Self.hierarchyJSON)
        guard case let .hierarchy(hierarchy) = try await makeClient(stub).fetchFreshHierarchyResult() else {
            return XCTFail("Expected decoded hierarchy")
        }
        XCTAssertEqual(hierarchy.bundleId, "com.example.app")
        XCTAssertEqual(hierarchy.timestamp, 7)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/hierarchy/fresh")
    }

    func testFreshResultReportsTimeout() async throws {
        let result = try await makeClient(StubHTTPTransport([.timedOut])).fetchFreshHierarchyResult()
        guard case let .failed(failure) = result else { return XCTFail("Expected timeout failure") }
        XCTAssertEqual(failure, .timedOut)
        XCTAssertEqual(failure.reason, "SDK hierarchy request timed out")
    }

    func testFetchFreshHierarchyNilOnTimeout() async throws {
        let hierarchy = try await makeClient(StubHTTPTransport([.timedOut])).fetchFreshHierarchy()
        XCTAssertNil(hierarchy)
    }

    func testFreshResultIsUnavailableWithoutHTTPResponse() async throws {
        // transportError throws URLError(.cannotConnectToHost), which remains unavailable.
        for outcome in [StubOutcome.transportError, .connectionLost, .nonHTTPResponse] {
            guard case .unavailable = try await makeClient(StubHTTPTransport([outcome])).fetchFreshHierarchyResult()
            else {
                return XCTFail("Expected unavailable for \(outcome)")
            }
        }
    }

    func testFreshResultReportsNon200Status() async throws {
        let result = try await makeClient(StubHTTPTransport(status: 404, body: Self.hierarchyJSON))
            .fetchFreshHierarchyResult()
        guard case let .failed(failure) = result else { return XCTFail("Expected HTTP failure") }
        XCTAssertEqual(failure, .httpStatus(404))
        XCTAssertTrue(failure.reason.contains("404"))
    }

    func testFreshResultReportsMalformedJSON() async throws {
        let result = try await makeClient(StubHTTPTransport(status: 200, body: Data("not json".utf8)))
            .fetchFreshHierarchyResult()
        guard case let .failed(.undecodable(reason)) = result else { return XCTFail("Expected decoding failure") }
        XCTAssertFalse(reason.isEmpty)
        XCTAssertTrue(reason.contains("dataCorrupted"))
    }

    func testFreshResultReportsMissingRequiredKey() async throws {
        let body = Data(#"{"bundleId":"com.example.app","screenScale":3,"screenWidth":393,"screenHeight":852}"#.utf8)
        let result = try await makeClient(StubHTTPTransport(status: 200, body: body)).fetchFreshHierarchyResult()
        guard case let .failed(.undecodable(reason)) = result else { return XCTFail("Expected decoding failure") }
        XCTAssertTrue(reason.contains("timestamp"), reason)
        XCTAssertTrue(reason.contains("keyNotFound"), reason)
    }

    // MARK: - /health routing + availability

    func testFetchServerInfoUsesHealthTransportOnly() async throws {
        let health = StubHTTPTransport(
            status: 200,
            body: Data(#"{"status":"ok","bundleId":"com.example.app","capabilities":["hierarchy"]}"#.utf8)
        )
        let main = StubHTTPTransport([.nonHTTPResponse])
        let info = try await makeClient(main, health: health).fetchServerInfo()
        XCTAssertEqual(info?.bundleId, "com.example.app")
        XCTAssertEqual(health.recordedRequests.first?.url?.path, "/health")
        XCTAssertTrue(main.recordedRequests.isEmpty, "server info must route to the health transport only")
    }

    func testIsAvailableReflectsHealth() async throws {
        let available = StubHTTPTransport(
            status: 200,
            body: Data(#"{"status":"ok","bundleId":null,"capabilities":[]}"#.utf8)
        )
        let unavailable = StubHTTPTransport([.transportError])
        let okClient = try await makeClient(unavailable, health: available).isAvailable()
        let downClient = try await makeClient(available, health: unavailable).isAvailable()
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
        let succeeded = try await makeClient(stub).setMockRules([rule])
        XCTAssertTrue(succeeded)

        let request = try XCTUnwrap(stub.recordedRequests.first)
        XCTAssertEqual(request.url?.path, "/network/mock")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual((json["rules"] as? [Any])?.count, 1)
    }

    func testSetMockRulesFalseOnNon200() async throws {
        let succeeded = try await makeClient(StubHTTPTransport(status: 500)).setMockRules([])
        XCTAssertFalse(succeeded)
    }

    // MARK: - Network mock rule report (#10101)

    func testPushMockRulesReturnsTheRulesTheSdkRejected() async throws {
        let body = Data(#"{"status":"ok","rejected":[{"mockId":"m1","reason":"invalid regex: x"}]}"#.utf8)
        let stub = StubHTTPTransport(status: 200, body: body)

        let outcome = try await makeClient(stub).pushMockRules([])

        XCTAssertEqual(
            outcome,
            SdkMockRulesOutcome(ok: true, rejectedMockIds: ["m1"], rejectedReasons: ["m1": "invalid regex: x"])
        )
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/network/mock")
        XCTAssertEqual(stub.recordedRequests.first?.httpMethod, "POST")
    }

    func testPushMockRulesTreatsAnEmptyRejectedListAsAReportThatNothingWasRejected() async throws {
        let stub = StubHTTPTransport(status: 200, body: Data(#"{"status":"ok","rejected":[]}"#.utf8))

        let outcome = try await makeClient(stub).pushMockRules([])

        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: true, rejectedMockIds: [], rejectedReasons: [:]))
    }

    func testPushMockRulesHasNoReportFromAnSdkThatPredatesIt() async throws {
        let stub = StubHTTPTransport(status: 200, body: Data(#"{"status":"ok"}"#.utf8))

        let outcome = try await makeClient(stub).pushMockRules([])

        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: true))
        XCTAssertNil(outcome.rejectedMockIds)
    }

    func testPushMockRulesFailsOnNon200() async throws {
        let outcome = try await makeClient(StubHTTPTransport(status: 500)).pushMockRules([])
        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: false))
    }

    func testPushMockRulesFailsOnTransportError() async throws {
        let outcome = try await makeClient(StubHTTPTransport([.transportError])).pushMockRules([])
        XCTAssertEqual(outcome, SdkMockRulesOutcome(ok: false))
    }

    func testSetNetworkErrorSimulationHitsPath() async throws {
        let stub = StubHTTPTransport(status: 200)
        let succeeded = try await makeClient(stub)
            .setNetworkErrorSimulation(NetworkErrorSimulationDTO(
                enabled: true,
                errorType: "timeout",
                limit: 1,
                expiresAtEpochMs: nil
            ))
        XCTAssertTrue(succeeded)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/network/error-simulation")
    }

    func testSetNetworkFaultRulesFalseOnTransportError() async throws {
        let succeeded = try await makeClient(StubHTTPTransport([.transportError])).setNetworkFaultRules([])
        XCTAssertFalse(succeeded)
    }

    // MARK: - addHighlight outcome classification

    func testAddHighlightRenderedOn200() async throws {
        let outcome = try await makeClient(StubHTTPTransport(status: 200)).addHighlight(
            id: "h",
            shape: Self.circleShape
        )
        XCTAssertEqual(outcome, .rendered)
    }

    func testAddHighlightRejectedOnNon200() async throws {
        let outcome = try await makeClient(StubHTTPTransport(status: 422)).addHighlight(
            id: "h",
            shape: Self.circleShape
        )
        XCTAssertEqual(outcome, .rejected)
    }

    func testAddHighlightUnavailableOnNonHTTP() async throws {
        let outcome = try await makeClient(StubHTTPTransport([.nonHTTPResponse])).addHighlight(
            id: "h",
            shape: Self.circleShape
        )
        XCTAssertEqual(outcome, .unavailable)
    }

    func testAddHighlightUnavailableOnTransportError() async throws {
        let outcome = try await makeClient(StubHTTPTransport([.transportError])).addHighlight(
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
