@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

final class SdkEndpointResolverTests: XCTestCase {
    private let udid = "ABCDEF00-1234-4567-89AB-000000000001"
    private let other = "ABCDEF00-1234-4567-89AB-000000000002"

    private final class Warnings: Sendable {
        private let state = OSAllocatedUnfairLock(initialState: [String]())
        func append(_ message: String) { state.withLock { $0.append(message) } }
        var messages: [String] { state.withLock { $0 } }
    }

    private func health(_ identity: String?) throws -> StubOutcome {
        var fields = ["status": "ok", "bundleId": "test.app"]
        if let identity { fields["simulatorUdid"] = identity }
        // Deliberately omit capabilities to exercise old-build health decoding too.
        return try .respond(status: 200, body: JSONEncoder().encode(fields))
    }

    private func mismatch() throws -> StubOutcome {
        try .respond(status: 409, body: JSONEncoder().encode([
            "error": "wrong_simulator", "expectedUdid": other, "actualUdid": udid,
        ]))
    }

    private func makeResolver(_ transport: StubHTTPTransport, warnings: Warnings = Warnings()) -> SdkEndpointResolver {
        SdkEndpointResolver(
            environment: ["SIMULATOR_UDID": udid], healthTransport: transport, warning: { warnings.append($0) }
        )
    }

    private var refusedCandidates: [StubOutcome] {
        Array(repeating: .transportError, count: SdkSimulatorPort.probeCount)
    }

    func testFirstMatchingCandidateWinsAndCacheAvoidsHealthRequests() async throws {
        let stub = try StubHTTPTransport([health(udid.lowercased()), health(other)])
        let resolver = makeResolver(stub)
        let first = try await resolver.resolve()
        let second = try await resolver.resolve()
        XCTAssertEqual(first.port, Int(SdkSimulatorPort.simulatorPort(udid: udid)))
        XCTAssertEqual(first, second)
        XCTAssertEqual(stub.recordedRequests.count, 1)
        XCTAssertEqual(stub.recordedRequests[0].url?.path, "/health")
        XCTAssertEqual(stub.recordedRequests[0].value(forHTTPHeaderField: SdkEndpointResolver.identityHeader), udid)
    }

    func testSkipsWrongAndIdentitylessDerivedCandidates() async throws {
        let stub = try StubHTTPTransport([health(other), health(nil), mismatch(), health(udid)])
        let result = try await makeResolver(stub).resolve()
        XCTAssertEqual(result.port, Int(SdkSimulatorPort.simulatorPort(udid: udid, attempt: 3)))
        XCTAssertEqual(stub.recordedRequests.map { $0.url?.port }, (0 ... 3).map {
            Int(SdkSimulatorPort.simulatorPort(udid: udid, attempt: $0))
        })
    }

    func testLegacyMatchingIdentityIsAccepted() async throws {
        let warnings = Warnings()
        let stub = try StubHTTPTransport(refusedCandidates + [health(udid.lowercased())])
        let result = try await makeResolver(stub, warnings: warnings).resolve()
        XCTAssertEqual(result.port, 8766)
        XCTAssertEqual(stub.recordedRequests.count, SdkSimulatorPort.probeCount + 1)
        XCTAssertTrue(warnings.messages.isEmpty)
    }

    func testLegacyWrongIdentityFailsForHealthAndGuardResponses() async throws {
        for outcome in try [health(other), mismatch()] {
            let stub = StubHTTPTransport(refusedCandidates + [outcome])
            do {
                _ = try await makeResolver(stub).resolve()
                XCTFail("Must not use another simulator's server")
            } catch let SdkEndpointError.wrongSimulator(expected, actual) {
                XCTAssertEqual(expected, udid)
                XCTAssertEqual(actual, other)
                let message = SdkEndpointError.wrongSimulatorMessage(expectedUdid: expected, actualUdid: actual)
                XCTAssertTrue(message.contains(udid))
                XCTAssertTrue(message.contains(other))
                XCTAssertTrue(message.contains("SDK app on this simulator is not reachable"))
            }
        }
    }

    func testLegacyIdentitylessSdkWarnsOnceEvenAfterCacheInvalidation() async throws {
        let warnings = Warnings()
        let script = try refusedCandidates + [health(nil)] + refusedCandidates + [health(nil)]
        let stub = StubHTTPTransport(script)
        let resolver = makeResolver(stub, warnings: warnings)
        let url = try await resolver.resolve()
        XCTAssertEqual(url.port, 8766)
        do {
            _ = try await resolver.data(for: URLRequest(url: url), transport: StubHTTPTransport([.transportError]))
            XCTFail("Expected transport failure")
        } catch is URLError {}
        let rediscovered = try await resolver.resolve()
        XCTAssertEqual(rediscovered.port, 8766)
        XCTAssertEqual(warnings.messages.count, 1)
        XCTAssertTrue(warnings.messages[0].contains("no simulator identity"))
        XCTAssertEqual(stub.recordedRequests.count, 2 * (SdkSimulatorPort.probeCount + 1))
    }

    func testNothingListeningIsUnavailableAndResolutionRemainsLazy() async throws {
        let stub = try StubHTTPTransport(refusedCandidates + [.transportError, health(udid)])
        let resolver = makeResolver(stub)
        XCTAssertTrue(stub.recordedRequests.isEmpty, "construction must not probe an app that may start later")
        do {
            _ = try await resolver.resolve()
            XCTFail("Expected SDK unavailable")
        } catch let SdkEndpointError.unavailable(message) {
            XCTAssertTrue(message.contains("SDK unavailable"))
            XCTAssertTrue(message.contains(udid))
        }
        let result = try await resolver.resolve()
        XCTAssertEqual(result.port, Int(SdkSimulatorPort.simulatorPort(udid: udid)))
    }

    func testTransportAndWrongSimulatorFailuresInvalidateCacheAndFindRelaunchedApp() async throws {
        for failure in try [StubOutcome.transportError, mismatch()] {
            let healthStub = try StubHTTPTransport([health(udid), .transportError, health(udid)])
            let resolver = makeResolver(healthStub)
            let dataStub = StubHTTPTransport([failure, .respond(status: 200, body: Data("own data".utf8))])
            let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/db/list")))
            do {
                _ = try await resolver.data(for: request, transport: dataStub)
                XCTFail("Expected failed request")
            } catch is URLError {
                // Transport error is preserved for client-specific unavailable mapping.
            } catch let SdkEndpointError.wrongSimulator(expected, actual) {
                XCTAssertEqual(expected, udid)
                XCTAssertEqual(actual, other)
            }
            let result = try await resolver.data(for: request, transport: dataStub)
            XCTAssertEqual(String(data: result.0, encoding: .utf8), "own data")
            XCTAssertEqual(healthStub.recordedRequests.count, 3)
            XCTAssertEqual(dataStub.recordedRequests.count, 2, "failed mutation requests are never retried")
            XCTAssertEqual(
                dataStub.recordedRequests.last?.url?.port,
                Int(SdkSimulatorPort.simulatorPort(udid: udid, attempt: 1))
            )
        }
    }

    func testPhysicalDeviceUsesLegacyWithoutHealthOrHeader() async throws {
        let healthStub = StubHTTPTransport([])
        let resolver = SdkEndpointResolver(environment: [:], healthTransport: healthStub)
        let dataStub = StubHTTPTransport(status: 200, body: Data())
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:9999/preferences")))
        _ = try await resolver.data(for: request, transport: dataStub)
        XCTAssertTrue(healthStub.recordedRequests.isEmpty)
        XCTAssertEqual(dataStub.recordedRequests.first?.url?.port, 8766)
        XCTAssertNil(dataStub.recordedRequests.first?.value(forHTTPHeaderField: SdkEndpointResolver.identityHeader))
    }

    func testAllClientsSendIdentityOnSimulatorAndNoneOnPhysicalDevice() async throws {
        let baseURL = try XCTUnwrap(URL(string: "http://localhost:8766"))
        for environment in [["SIMULATOR_UDID": udid], [:]] {
            let healthStub = try StubHTTPTransport([health(udid)])
            let resolver = SdkEndpointResolver(environment: environment, healthTransport: healthStub)
            let hierarchyTransport = StubHTTPTransport([
                .respond(status: 200, body: Data()), .respond(status: 200, body: Data()),
                .respond(status: 200, body: Data()),
            ])
            let hierarchy = SdkHierarchyClient(
                baseURL: baseURL, transport: hierarchyTransport, healthTransport: hierarchyTransport,
                endpointResolver: resolver
            )
            _ = await hierarchy.fetchHierarchy()
            _ = await hierarchy.fetchServerInfo()
            _ = await hierarchy.setMockRules([])
            let databaseTransport = StubHTTPTransport(status: 200, body: Data("{\"databases\":[]}".utf8))
            _ = try await SdkDatabaseClient(baseURL: baseURL, transport: databaseTransport, endpointResolver: resolver)
                .listDatabases()
            let preferenceTransport = StubHTTPTransport(status: 200, body: Data("{\"files\":[]}".utf8))
            _ = try await SdkPreferenceClient(
                baseURL: baseURL,
                transport: preferenceTransport,
                endpointResolver: resolver
            )
            .list(appId: "test.app")
            let requests = hierarchyTransport.recordedRequests
                + databaseTransport.recordedRequests + preferenceTransport.recordedRequests
            XCTAssertEqual(requests.count, 5)
            for request in requests {
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: SdkEndpointResolver.identityHeader),
                    environment["SIMULATOR_UDID"]
                )
                let expectedPort = environment.isEmpty ? 8766 : Int(SdkSimulatorPort.simulatorPort(udid: udid))
                XCTAssertEqual(request.url?.port, expectedPort)
            }
            XCTAssertEqual(
                healthStub.recordedRequests.count,
                environment.isEmpty ? 0 : 1,
                "all clients must share discovery"
            )
        }
    }

    func testEachClientRejectsWrongSimulatorWithoutDecodingData() async throws {
        let baseURL = try XCTUnwrap(URL(string: "http://localhost:8766"))
        let outcome = try mismatch()
        let databaseResolver = try makeResolver(StubHTTPTransport([health(udid)]))
        do {
            _ = try await SdkDatabaseClient(
                baseURL: baseURL, transport: StubHTTPTransport([outcome]), endpointResolver: databaseResolver
            ).listDatabases()
            XCTFail("Expected typed database failure, never data")
        } catch let SdkDatabaseError.wrongSimulator(expected, actual) {
            XCTAssertEqual(expected, udid)
            XCTAssertEqual(actual, other)
        }
        let preferenceResolver = try makeResolver(StubHTTPTransport([health(udid)]))
        do {
            _ = try await SdkPreferenceClient(
                baseURL: baseURL, transport: StubHTTPTransport([outcome]), endpointResolver: preferenceResolver
            ).get(appId: "test.app", suiteName: "Standard", key: "key")
            XCTFail("Expected typed preference failure, never data")
        } catch let PreferenceError.wrongSimulator(expected, actual) {
            XCTAssertEqual(expected, udid)
            XCTAssertEqual(actual, other)
        }
        // The hierarchy API deliberately retains its nil/false/unavailable failure style.
        let hierarchyResolver = try makeResolver(StubHTTPTransport(Array(repeating: health(udid), count: 4)))
        let hierarchyTransport = StubHTTPTransport(Array(repeating: outcome, count: 4))
        let hierarchy = SdkHierarchyClient(
            baseURL: baseURL, transport: hierarchyTransport, healthTransport: hierarchyTransport,
            endpointResolver: hierarchyResolver
        )
        let snapshot = await hierarchy.fetchHierarchy()
        let info = await hierarchy.fetchServerInfo()
        let posted = await hierarchy.setMockRules([])
        let highlight = await hierarchy.addHighlight(
            id: "test", shape: HighlightShape(type: .circle, bounds: HighlightBounds(x: 0, y: 0, width: 10, height: 10))
        )
        XCTAssertNil(snapshot)
        XCTAssertNil(info)
        XCTAssertFalse(posted)
        XCTAssertEqual(highlight, .unavailable)
    }

    func testWrongLegacyServerNeverReceivesAClientRoute() async throws {
        let baseURL = try XCTUnwrap(URL(string: "http://localhost:8766"))
        let healthStub = try StubHTTPTransport(refusedCandidates + [health(other)])
        let dataStub = StubHTTPTransport([])
        let client = SdkDatabaseClient(
            baseURL: baseURL,
            transport: dataStub,
            endpointResolver: makeResolver(healthStub)
        )
        do {
            _ = try await client.executeSQL(databasePath: "/db", query: "DELETE FROM items")
            XCTFail("Expected identity mismatch before SQL")
        } catch let SdkDatabaseError.wrongSimulator(expected, actual) {
            XCTAssertEqual(expected, udid)
            XCTAssertEqual(actual, other)
        }
        XCTAssertTrue(dataStub.recordedRequests.isEmpty)
    }
}
