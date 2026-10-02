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

    private func makeResolver(_ transport: any HTTPRequesting, warnings: Warnings = Warnings()) -> SdkEndpointResolver {
        SdkEndpointResolver(
            environment: ["SIMULATOR_UDID": udid], healthTransport: transport, warning: { warnings.append($0) }
        )
    }

    private var refusedCandidates: [StubOutcome] {
        Array(repeating: .transportError, count: SdkSimulatorPort.probeCount)
    }

    /// Two apps share a simulator's probe sequence; A also owns the legacy listener.
    /// Foreground transitions are explicit and every response is in-memory.
    private final class SimulatorAppsTransport: HTTPRequesting {
        static let appA = "test.app.a"
        static let appB = "test.app.b"
        let udid: String
        let portA: Int
        let portB: Int

        private struct State {
            var foreground: String? = SimulatorAppsTransport.appA
            var bRunning = true
            var requests: [URLRequest] = []
        }

        private let state = OSAllocatedUnfairLock(initialState: State())

        init(udid: String) {
            self.udid = udid
            portA = Int(SdkSimulatorPort.simulatorPort(udid: udid))
            portB = Int(SdkSimulatorPort.simulatorPort(udid: udid, attempt: 1))
        }

        func setForeground(_ bundleId: String?, bRunning: Bool = true) {
            state.withLock {
                $0.foreground = bundleId
                $0.bRunning = bRunning
            }
        }

        var recordedRequests: [URLRequest] { state.withLock { $0.requests } }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let outcome: StubOutcome = try state.withLock { state in
                state.requests.append(request)
                let bundleId: String
                switch request.url?.port {
                case portA, 8766:
                    bundleId = Self.appA
                case portB where state.bRunning:
                    bundleId = Self.appB
                default:
                    return .transportError
                }
                guard state.foreground == bundleId else {
                    return .respond(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8))
                }
                if request.url?.path == "/health" {
                    return try .respond(status: 200, body: JSONEncoder().encode([
                        "status": "ok", "bundleId": bundleId, "simulatorUdid": udid,
                    ]))
                }
                return .respond(status: 200, body: Data(bundleId.utf8))
            }
            return try await StubHTTPTransport([outcome]).data(for: request)
        }
    }

    func testForegroundSwitchRetriesGetOnNextAppAndKeepsItsCache() async throws {
        let apps = SimulatorAppsTransport(udid: udid)
        let resolver = makeResolver(apps)
        var request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/hierarchy?fresh=true")))
        request.setValue("preserved", forHTTPHeaderField: "X-Test-Request")
        let first = try await resolver.data(for: request, transport: apps)
        XCTAssertEqual(String(data: first.0, encoding: .utf8), SimulatorAppsTransport.appA)
        XCTAssertEqual(apps.recordedRequests.map { $0.url?.port }, [apps.portA, apps.portA])

        apps.setForeground(SimulatorAppsTransport.appB)
        let switched = try await resolver.data(for: request, transport: apps)
        XCTAssertEqual(String(data: switched.0, encoding: .utf8), SimulatorAppsTransport.appB)
        XCTAssertEqual(apps.recordedRequests.map { $0.url?.port }, [
            apps.portA, apps.portA, apps.portA, apps.portA, apps.portB, apps.portB,
        ])
        let beforeCachedRead = apps.recordedRequests.count
        let cached = try await resolver.data(for: request, transport: apps)
        XCTAssertEqual(String(data: cached.0, encoding: .utf8), SimulatorAppsTransport.appB)
        XCTAssertEqual(apps.recordedRequests.count, beforeCachedRead + 1, "cached B needs no extra probes")
        XCTAssertEqual(apps.recordedRequests.last?.url?.port, apps.portB)
        XCTAssertEqual(apps.recordedRequests.last?.url?.query, "fresh=true")
        XCTAssertEqual(apps.recordedRequests.last?.value(forHTTPHeaderField: "X-Test-Request"), "preserved")
        for sent in apps.recordedRequests {
            XCTAssertEqual(sent.value(forHTTPHeaderField: SdkEndpointResolver.identityHeader), udid)
        }
    }

    func testForegroundSwitchBackRediscoverAppA() async throws {
        let apps = SimulatorAppsTransport(udid: udid)
        let resolver = makeResolver(apps)
        var request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/hierarchy")))
        request.httpMethod = "GET"
        _ = try await resolver.resolve()
        apps.setForeground(SimulatorAppsTransport.appB)
        let switched = try await resolver.data(for: request, transport: apps)
        XCTAssertEqual(String(data: switched.0, encoding: .utf8), SimulatorAppsTransport.appB)
        apps.setForeground(SimulatorAppsTransport.appA)
        let returned = try await resolver.data(for: request, transport: apps)
        XCTAssertEqual(String(data: returned.0, encoding: .utf8), SimulatorAppsTransport.appA)
        XCTAssertEqual(apps.recordedRequests.map { $0.url?.port }, [
            apps.portA, apps.portA, apps.portA, apps.portB, apps.portB, apps.portB, apps.portA, apps.portA,
        ])
    }

    func testBackgroundAppsIncludingLegacyListenerAreUnavailable() async throws {
        for bRunning in [false, true] {
            let apps = SimulatorAppsTransport(udid: udid)
            let resolver = makeResolver(apps)
            _ = try await resolver.resolve()
            apps.setForeground(nil, bRunning: bRunning)
            let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/hierarchy")))
            do {
                _ = try await resolver.data(for: request, transport: apps)
                XCTFail("A background app must not supply data, even through legacy port 8766")
            } catch let SdkEndpointError.unavailable(message) {
                XCTAssertTrue(message.contains(udid))
            }
            XCTAssertEqual(apps.recordedRequests.last?.url?.port, 8766)
            XCTAssertEqual(apps.recordedRequests.last?.url?.path, "/health")
            XCTAssertEqual(apps.recordedRequests.filter { $0.url?.path == "/hierarchy" }.count, 1)
        }
    }

    func testInactivePostIsSentOnceAndNextCallResolvesAppB() async throws {
        let apps = SimulatorAppsTransport(udid: udid)
        let resolver = makeResolver(apps)
        _ = try await resolver.resolve()
        apps.setForeground(SimulatorAppsTransport.appB)
        let body = Data("{\"error\":\"app_not_active\"}".utf8)
        let dataStub = StubHTTPTransport(status: 409, body: body)
        var request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/db/execute")))
        request.httpMethod = "POST"
        let result = try await resolver.data(for: request, transport: dataStub)
        XCTAssertEqual(result.0, body)
        XCTAssertEqual((result.1 as? HTTPURLResponse)?.statusCode, 409)
        XCTAssertEqual(dataStub.recordedRequests.count, 1)
        XCTAssertEqual(dataStub.recordedRequests.first?.url?.port, apps.portA)
        XCTAssertEqual(apps.recordedRequests.count, 1, "a mutation must not even rediscover immediately")
        let next = try await resolver.data(for: request, transport: apps)
        XCTAssertEqual(String(data: next.0, encoding: .utf8), SimulatorAppsTransport.appB)
        XCTAssertEqual(apps.recordedRequests.last?.url?.port, apps.portB)
    }

    func testHierarchyServerInfoFollowsForegroundSwitch() async throws {
        let apps = SimulatorAppsTransport(udid: udid)
        let client = try SdkHierarchyClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")), transport: apps, healthTransport: apps,
            endpointResolver: makeResolver(apps)
        )
        let first = await client.fetchServerInfo()
        XCTAssertEqual(first?.bundleId, SimulatorAppsTransport.appA)
        apps.setForeground(SimulatorAppsTransport.appB)
        let switched = await client.fetchServerInfo()
        XCTAssertEqual(switched?.bundleId, SimulatorAppsTransport.appB)
        XCTAssertEqual(apps.recordedRequests.last?.url?.port, apps.portB)
    }

    func testDatabaseMutationPreservesInactiveErrorWithoutRetryAndInvalidatesCache() async throws {
        let apps = SimulatorAppsTransport(udid: udid)
        let resolver = makeResolver(apps)
        _ = try await resolver.resolve()
        apps.setForeground(SimulatorAppsTransport.appB)
        let dataStub = StubHTTPTransport(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8))
        let client = try SdkDatabaseClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")), transport: dataStub, endpointResolver: resolver
        )
        do {
            _ = try await client.executeSQL(databasePath: "/db", query: "DELETE FROM items")
            XCTFail("Expected existing unavailable handling")
        } catch let SdkDatabaseError.unavailable(message) {
            XCTAssertTrue(message.contains("app_not_active"))
        }
        XCTAssertEqual(dataStub.recordedRequests.count, 1)
        XCTAssertEqual(dataStub.recordedRequests.first?.url?.port, apps.portA)
        let next = try await resolver.resolve()
        XCTAssertEqual(next.port, apps.portB)
    }

    func testPreferenceMutationPreservesForegroundConflictWithoutRetryAndInvalidatesCache() async throws {
        let apps = SimulatorAppsTransport(udid: udid)
        let resolver = makeResolver(apps)
        _ = try await resolver.resolve()
        apps.setForeground(SimulatorAppsTransport.appB)
        let dataStub = StubHTTPTransport(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8))
        let client = try SdkPreferenceClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")), transport: dataStub, endpointResolver: resolver
        )
        do {
            _ = try await client.set(
                appId: SimulatorAppsTransport.appA, suiteName: "Standard", key: "key", value: "value", type: "string",
                sessionId: "session", mutationToken: "token"
            )
            XCTFail("Expected existing not-foreground handling")
        } catch let PreferenceError.conflict(reason) {
            XCTAssertEqual(reason, "app_not_active")
            XCTAssertTrue(PreferenceError.conflict(reason).localizedDescription.contains("bring it to the foreground"))
        }
        XCTAssertEqual(dataStub.recordedRequests.count, 1)
        XCTAssertEqual(dataStub.recordedRequests.first?.url?.port, apps.portA)
        let next = try await resolver.resolve()
        XCTAssertEqual(next.port, apps.portB)
    }

    func testAppNotActiveDetectorRequires409AndDecodedError() async throws {
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/health")))
        for (status, body, expected) in [
            (409, "{\"error\":\"app_not_active\"}", true),
            (409, "{\"error\":\"wrong_simulator\"}", false),
            (200, "{\"error\":\"app_not_active\"}", false),
            (409, "not json", false),
            (409, "{}", false),
            (409, "{\"error\":409}", false),
        ] {
            let result = try await StubHTTPTransport(status: status, body: Data(body.utf8)).data(for: request)
            XCTAssertEqual(SdkEndpointError.isAppNotActive(data: result.0, response: result.1), expected)
        }
        let stub = StubHTTPTransport(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8))
        let fixedResult = try await SdkEndpointResolver.requestData(for: request, transport: stub, resolver: nil)
        XCTAssertTrue(SdkEndpointError.isAppNotActive(data: fixedResult.0, response: fixedResult.1))
        XCTAssertEqual(stub.recordedRequests.count, 1, "nil-resolver requests keep fixed-endpoint semantics")
        let nonHTTP = try await StubHTTPTransport([.nonHTTPResponse]).data(for: request)
        XCTAssertFalse(SdkEndpointError.isAppNotActive(
            data: Data("{\"error\":\"app_not_active\"}".utf8), response: nonHTTP.1
        ))
    }

    func testSecondInactiveResponseIsReturnedWithoutRetryAndInvalidatesReplacement() async throws {
        let inactive = StubOutcome.respond(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8))
        let healthStub = try StubHTTPTransport([health(udid), inactive, health(udid), health(udid)])
        let resolver = makeResolver(healthStub)
        _ = try await resolver.resolve()
        let dataStub = StubHTTPTransport([inactive, inactive, .respond(status: 200, body: Data("A data".utf8))])
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/hierarchy")))
        let result = try await resolver.data(for: request, transport: dataStub)
        XCTAssertTrue(SdkEndpointError.isAppNotActive(data: result.0, response: result.1))
        XCTAssertEqual(dataStub.recordedRequests.count, 2, "a second inactive response must not retry again")
        XCTAssertEqual(dataStub.recordedRequests.last?.url?.port, Int(SdkSimulatorPort.simulatorPort(
            udid: udid, attempt: 1
        )))
        XCTAssertEqual(healthStub.recordedRequests.count, 3)
        let next = try await resolver.data(for: request, transport: dataStub)
        XCTAssertEqual(String(data: next.0, encoding: .utf8), "A data")
        XCTAssertEqual(healthStub.recordedRequests.count, 4, "the second inactive endpoint must be evicted")
    }

    func testRediscoveringSameEndpointReturnsOriginalInactiveResponseWithoutResending() async throws {
        let healthStub = try StubHTTPTransport([health(udid), health(udid)])
        let resolver = makeResolver(healthStub)
        let body = Data("{\"error\":\"app_not_active\"}".utf8)
        let dataStub = StubHTTPTransport(status: 409, body: body)
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/hierarchy")))
        let result = try await resolver.data(for: request, transport: dataStub)
        XCTAssertEqual(result.0, body)
        XCTAssertEqual((result.1 as? HTTPURLResponse)?.statusCode, 409)
        XCTAssertEqual(healthStub.recordedRequests.count, 2, "inactive GET must invalidate and rediscover once")
        XCTAssertEqual(dataStub.recordedRequests.count, 1, "do not resend to the same endpoint")
    }

    func testRetryTransportAndWrongSimulatorFailuresInvalidateReplacement() async throws {
        let inactive = StubOutcome.respond(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8))
        for failure in try [StubOutcome.transportError, mismatch()] {
            let healthStub = try StubHTTPTransport([health(udid), .transportError, health(udid), health(udid)])
            let resolver = makeResolver(healthStub)
            let dataStub = StubHTTPTransport([inactive, failure, .respond(status: 200, body: Data("A data".utf8))])
            let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:8766/hierarchy")))
            do {
                _ = try await resolver.data(for: request, transport: dataStub)
                XCTFail("The retried request must preserve transport and identity failures")
            } catch is URLError {
                // Preserve the same transport failure as the initial request path.
            } catch let SdkEndpointError.wrongSimulator(expected, actual) {
                XCTAssertEqual(expected, udid)
                XCTAssertEqual(actual, other)
            }
            XCTAssertEqual(dataStub.recordedRequests.count, 2)
            XCTAssertEqual(
                dataStub.recordedRequests.last?.value(forHTTPHeaderField: SdkEndpointResolver.identityHeader),
                udid
            )
            let next = try await resolver.data(for: request, transport: dataStub)
            XCTAssertEqual(String(data: next.0, encoding: .utf8), "A data")
            XCTAssertEqual(healthStub.recordedRequests.count, 4, "a failed retry must invalidate its own endpoint")
        }
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
        let dataStub = StubHTTPTransport([
            .respond(status: 200, body: Data()),
            .respond(status: 409, body: Data("{\"error\":\"app_not_active\"}".utf8)),
        ])
        let request = try URLRequest(url: XCTUnwrap(URL(string: "http://localhost:9999/preferences")))
        _ = try await resolver.data(for: request, transport: dataStub)
        XCTAssertTrue(healthStub.recordedRequests.isEmpty)
        XCTAssertEqual(dataStub.recordedRequests.first?.url?.port, 8766)
        XCTAssertNil(dataStub.recordedRequests.first?.value(forHTTPHeaderField: SdkEndpointResolver.identityHeader))
        let inactive = try await resolver.data(for: request, transport: dataStub)
        XCTAssertTrue(SdkEndpointError.isAppNotActive(data: inactive.0, response: inactive.1))
        XCTAssertEqual(dataStub.recordedRequests.count, 2, "physical-device requests must not retry")
        XCTAssertTrue(healthStub.recordedRequests.isEmpty)
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
