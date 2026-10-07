@testable import CtrlProxyRewrite
import Foundation
import XCTest

private actor FakeSdkHierarchyClient: SdkHierarchyFetching {
    private var serverInfo: SdkHierarchyServerInfo?
    private let hierarchy: SdkViewHierarchy?
    private var networkErrorCalls = 0

    init(serverInfo: SdkHierarchyServerInfo?, hierarchy: SdkViewHierarchy? = nil) {
        self.serverInfo = serverInfo
        self.hierarchy = hierarchy
    }

    func networkErrorCallCount() -> Int {
        networkErrorCalls
    }

    private var mockRulesOutcome: SdkMockRulesOutcome?

    func stubMockRulesOutcome(_ outcome: SdkMockRulesOutcome) {
        mockRulesOutcome = outcome
    }

    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { hierarchy }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? { serverInfo }
    func isAvailable() async -> Bool { serverInfo != nil }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { serverInfo != nil }

    func pushMockRules(_: [NetworkMockRuleDTO]) async -> SdkMockRulesOutcome {
        mockRulesOutcome ?? SdkMockRulesOutcome(ok: serverInfo != nil)
    }

    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { serverInfo != nil }

    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool {
        networkErrorCalls += 1
        return serverInfo != nil
    }

    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome {
        serverInfo == nil ? .unavailable : .rendered
    }
}

private actor RejectingSdkDatabaseClient: SdkDatabaseFetching {
    private var calls = 0

    func callCount() -> Int { calls }

    private func unexpectedCall<T>() throws -> T {
        calls += 1
        throw SdkDatabaseError.unavailable("Unexpected database call")
    }

    func executeSQL(
        databasePath _: String,
        query _: String,
        sessionId _: String?,
        mutationToken _: String?
    )
        async throws -> SdkExecuteSqlResult
    {
        try unexpectedCall()
    }

    func listDatabases() async throws -> [SdkDatabaseInfo] { try unexpectedCall() }
    func storageCapabilities() async throws -> SdkStorageCapabilities { try unexpectedCall() }
    func listTables(databasePath _: String) async throws -> [String] { try unexpectedCall() }
    func getTableData(
        databasePath _: String,
        table _: String,
        limit _: Int,
        offset _: Int
    )
        async throws -> SdkTableDataResult
    {
        try unexpectedCall()
    }

    func getTableStructure(
        databasePath _: String,
        table _: String
    )
        async throws -> SdkTableStructureResult
    {
        try unexpectedCall()
    }
}

@MainActor
final class SdkCapabilitiesCommandTests: XCTestCase {
    private func handler(
        foregroundBundleId: String,
        sdkClient: FakeSdkHierarchyClient,
        databaseClient: (any SdkDatabaseFetching)? = nil
    )
        -> CommandHandler
    {
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = foregroundBundleId
        return CommandHandler(
            elementLocator: locator,
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            sdkHierarchyClient: sdkClient,
            sdkDatabaseClient: databaseClient
        )
    }

    private func request(_ json: String) throws -> WebSocketRequest {
        try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
    }

    private func semanticLinkHandler(_ ownerLinks: [[SdkSemanticLink]])
        -> (CommandHandler, RewriteFakeGesturePerformer)
    {
        let bounds = SdkBounds(left: 0, top: 0, right: 200, bottom: 100)
        let hierarchy = SdkViewHierarchy(
            timestamp: 0, bundleId: "com.example.sdk", screenScale: 3, screenWidth: 393, screenHeight: 852,
            root: SdkViewNode(
                className: "Root", bounds: bounds,
                children: ownerLinks.enumerated().map { index, links in
                    SdkViewNode(
                        className: "Label", bounds: bounds, accessibilityIdentifier: "owner_\(index)",
                        semanticLinks: links
                    )
                }
            )
        )
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.sdk"), hierarchy: hierarchy
        )
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = "com.example.sdk"
        let gestures = RewriteFakeGesturePerformer()
        return (
            CommandHandler(
                elementLocator: locator, gesturePerformer: gestures, perf: PerfProvider(), sdkHierarchyClient: sdkClient
            ),
            gestures
        )
    }

    func testOwnerlessSemanticLinkTapsItsOccurrenceCoordinateWithoutFallback() async throws {
        let (handler, gestures) = semanticLinkHandler([[
            SdkSemanticLink(text: "Terms", occurrence: 1, centerX: 20, centerY: 30),
            SdkSemanticLink(text: "Terms", occurrence: 0, centerX: 10, centerY: 20),
        ]])
        let payload = try await handler.handle(
            request(#"{"type":"request_activate_accessibility_link","text":"terms","occurrence":1}"#)
        ) as? WebSocketResponse
        let response = try XCTUnwrap(payload)

        XCTAssertEqual(response.success, true)
        XCTAssertNil(response.warning)
        XCTAssertEqual(gestures.tapCalls, 1)
        XCTAssertEqual(gestures.lastTap?.x, 20)
        XCTAssertEqual(gestures.lastTap?.y, 30)
        XCTAssertEqual(gestures.activateAccessibilityLinkCalls, 0)
    }

    func testOwnerlessSemanticLinkMultipleOwnersReturnsWarning() async throws {
        let (handler, gestures) = semanticLinkHandler([
            [SdkSemanticLink(text: "Terms", occurrence: 0, centerX: 10, centerY: 20)],
            [SdkSemanticLink(text: "Terms", occurrence: 0, centerX: 50, centerY: 60)],
        ])
        let payload = try await handler.handle(
            request(#"{"type":"request_activate_accessibility_link","text":"Terms","occurrence":0}"#)
        ) as? WebSocketResponse
        let response = try XCTUnwrap(payload)

        XCTAssertEqual(response.success, true)
        let warning = try XCTUnwrap(response.warning)
        XCTAssertTrue(warning.contains("owner_0"))
        XCTAssertTrue(warning.contains("2 candidate owners"))
        XCTAssertTrue(warning.contains("container/subtext"))
        // Check the actual optional wire field, not just the in-memory envelope.
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(decoded.warning, warning)
        XCTAssertEqual(gestures.lastTap?.x, 10)
        XCTAssertEqual(gestures.tapCalls, 1)
        XCTAssertEqual(gestures.activateAccessibilityLinkCalls, 0)
    }

    func testOwnerlessSemanticLinkUnresolvedFirstOwnerStillCallsFallback() async throws {
        let (handler, gestures) = semanticLinkHandler([
            [SdkSemanticLink(text: "Terms", occurrence: 0, centerX: 10, centerY: 20)],
            [SdkSemanticLink(text: "Terms", occurrence: 0, centerX: 50, centerY: 60)],
        ])
        let payload = try await handler.handle(
            request(#"{"type":"request_activate_accessibility_link","text":"Terms","occurrence":1}"#)
        ) as? WebSocketResponse
        let response = try XCTUnwrap(payload)

        XCTAssertEqual(response.success, true)
        XCTAssertNil(response.warning)
        XCTAssertEqual(gestures.tapCalls, 0)
        XCTAssertEqual(gestures.activateAccessibilityLinkCalls, 1)
    }

    func testAbsentSdkIsReportedWithoutIssuingNetworkMutation() async throws {
        let sdkClient = FakeSdkHierarchyClient(serverInfo: nil)
        let handler = handler(foregroundBundleId: "com.apple.springboard", sdkClient: sdkClient)

        let capabilityResponse = try await handler.handle(
            request(#"{"type":"get_sdk_capabilities","requestId":"cap-1"}"#)
        ) as? SdkCapabilitiesResponse
        let networkResponse = try await handler.handle(
            request(#"{"type":"set_network_error_simulation","requestId":"net-1","enabled":false}"#)
        ) as? SetNetworkErrorSimulationResponse

        XCTAssertEqual(capabilityResponse?.available, false)
        XCTAssertEqual(capabilityResponse?.capabilities, [])
        XCTAssertEqual(networkResponse?.ok, false)
        let callCount = await sdkClient.networkErrorCallCount()
        XCTAssertEqual(callCount, 0)
    }

    func testMatchingForegroundSdkAdvertisesAndExecutesNetworkMutation() async throws {
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(
                status: "ok",
                bundleId: "com.example.sdk",
                capabilities: ["network-fault-rules", "magic-tap"]
            )
        )
        let handler = handler(foregroundBundleId: "com.example.sdk", sdkClient: sdkClient)

        let capabilityResponse = try await handler.handle(
            request(#"{"type":"get_sdk_capabilities","requestId":"cap-1"}"#)
        ) as? SdkCapabilitiesResponse
        let networkResponse = try await handler.handle(
            request(#"{"type":"set_network_error_simulation","requestId":"net-1","enabled":true}"#)
        ) as? SetNetworkErrorSimulationResponse

        XCTAssertEqual(capabilityResponse?.available, true)
        XCTAssertEqual(capabilityResponse?.bundleId, "com.example.sdk")
        XCTAssertTrue(capabilityResponse?.capabilities.contains("network_error_simulation") == true)
        XCTAssertTrue(capabilityResponse?.capabilities.contains("magic_tap") == true)
        XCTAssertEqual(networkResponse?.ok, true)
        let callCount = await sdkClient.networkErrorCallCount()
        XCTAssertEqual(callCount, 1)
    }

    // MARK: - set_network_mock_rules report (#10101)

    private func mockRulesResponseJSON(
        _ sdkClient: FakeSdkHierarchyClient,
        foregroundBundleId: String = "com.example.sdk"
    )
        async throws -> [String: Any]
    {
        let handler = handler(foregroundBundleId: foregroundBundleId, sdkClient: sdkClient)
        let response = try await handler.handle(
            request(#"{"type":"set_network_mock_rules","requestId":"mock-1","rules":[]}"#)
        ) as? SetNetworkMockRulesResponse
        let encoded = try JSONEncoder().encode(XCTUnwrap(response))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    }

    func testMockRulesResultNamesTheRulesTheSdkRejected() async throws {
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.sdk")
        )
        await sdkClient.stubMockRulesOutcome(
            SdkMockRulesOutcome(ok: true, rejectedMockIds: ["m1"], rejectedReasons: ["m1": "invalid regex: x"])
        )

        let json = try await mockRulesResponseJSON(sdkClient)

        XCTAssertEqual(json["type"] as? String, "set_network_mock_rules_result")
        XCTAssertEqual(json["requestId"] as? String, "mock-1")
        XCTAssertEqual(json["ok"] as? Bool, true)
        XCTAssertEqual(json["rejectedMockIds"] as? [String], ["m1"])
        XCTAssertEqual(json["rejectedReasons"] as? [String: String], ["m1": "invalid regex: x"])
    }

    func testMockRulesResultOmitsTheReportWhenTheSdkDidNotSendOne() async throws {
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.sdk")
        )

        let json = try await mockRulesResponseJSON(sdkClient)

        XCTAssertEqual(json["ok"] as? Bool, true)
        XCTAssertNil(json["rejectedMockIds"], "no report must not read as 'nothing rejected'")
        XCTAssertNil(json["rejectedReasons"])
    }

    func testMockRulesResultKeepsAnEmptyRejectedListDistinctFromNoReport() async throws {
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.sdk")
        )
        await sdkClient.stubMockRulesOutcome(
            SdkMockRulesOutcome(ok: true, rejectedMockIds: [], rejectedReasons: [:])
        )

        let json = try await mockRulesResponseJSON(sdkClient)

        XCTAssertEqual((json["rejectedMockIds"] as? [Any])?.count, 0)
    }

    func testMockRulesResultFailsWithoutAForegroundSdk() async throws {
        let sdkClient = FakeSdkHierarchyClient(serverInfo: nil)

        let json = try await mockRulesResponseJSON(sdkClient, foregroundBundleId: "com.apple.springboard")

        XCTAssertEqual(json["ok"] as? Bool, false)
        XCTAssertNil(json["rejectedMockIds"])
    }

    func testOldSdkDoesNotAdvertiseMagicTap() async throws {
        let sdk = FakeSdkHierarchyClient(serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app"))
        let response = try await handler(foregroundBundleId: "com.example.app", sdkClient: sdk).handle(
            request(#"{"type":"get_sdk_capabilities"}"#)
        ) as? SdkCapabilitiesResponse
        XCTAssertEqual(response?.available, true)
        XCTAssertFalse(response?.capabilities.contains("magic_tap") == true)
        XCTAssertTrue(response?.capabilities.contains("highlight") == true)
    }

    func testForegroundTransitionInvalidatesPreviouslyReachableSdk() async throws {
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.previous")
        )
        let handler = handler(foregroundBundleId: "com.apple.springboard", sdkClient: sdkClient)

        let response = try await handler.handle(
            request(#"{"type":"get_sdk_capabilities","requestId":"cap-1"}"#)
        ) as? SdkCapabilitiesResponse

        XCTAssertEqual(response?.available, false)
        XCTAssertNil(response?.bundleId)
    }

    func testDatabaseRequestForBackgroundSdkMakesNoDatabaseCall() async throws {
        let sdkClient = FakeSdkHierarchyClient(
            serverInfo: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.background")
        )
        let databaseClient = RejectingSdkDatabaseClient()
        let handler = handler(
            foregroundBundleId: "com.example.foreground",
            sdkClient: sdkClient,
            databaseClient: databaseClient
        )

        let response = try await handler.handle(
            request(
                #"{"type":"list_databases","requestId":"db-1","appId":"com.example.background"}"#
            )
        ) as? ListDatabasesResponse

        XCTAssertEqual(response?.success, false)
        let callCount = await databaseClient.callCount()
        XCTAssertEqual(callCount, 0)
    }
}

private actor ProbeCountingSdkClient: SdkHierarchyFetching {
    private var probes = 0

    func probeCount() -> Int { probes }
    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? {
        probes += 1
        return SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app")
    }

    func isAvailable() async -> Bool { true }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { false }
    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { false }
    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool { false }
    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome { .unavailable }
}

@MainActor
final class SdkHierarchyProbeDecisionTests: XCTestCase {
    func testDecisionForEveryAppStateAndCacheRelationship() {
        let states: [ObservedAppState] = [
            .unknown, .notRunning, .runningBackgroundSuspended,
            .runningBackground, .runningForeground,
        ]
        for state in states {
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.apple.springboard",
                    cachedBundleId: nil,
                    appState: state
                ), .skip
            )
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.apple.springboard",
                    cachedBundleId: "com.example.app",
                    appState: state
                ), .clear
            )
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.example.app",
                    cachedBundleId: "com.example.other",
                    appState: state
                ), .clear
            )
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.example.app",
                    cachedBundleId: "",
                    appState: state
                ), .clear
            )
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.example.app",
                    cachedBundleId: nil,
                    appState: state
                ), state == .runningForeground ? .probe : .skip
            )
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.example.app",
                    cachedBundleId: "com.example.app",
                    appState: state
                ), state == .runningForeground ? .skip : .clear
            )
        }
    }

    func testSpringBoardAndMismatchedCacheNeverProbeSdk() async {
        let sdk = ProbeCountingSdkClient()
        let cache = SdkHierarchyCache()
        let locator = RewriteFakeElementLocator()
        locator.appState = .runningForeground
        let handler = CommandHandler(
            elementLocator: locator,
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            sdkHierarchyClient: sdk,
            sdkHierarchyCache: cache
        )
        let cached = SdkViewHierarchy(
            timestamp: 1, bundleId: "com.example.app", screenScale: 3,
            screenWidth: 393, screenHeight: 852, root: nil
        )
        cache.update(cached)
        _ = await handler.enrichWithMatchingSdkHierarchy(hierarchy(bundleId: "com.apple.springboard"))
        XCTAssertNil(cache.latest)
        let springboardProbes = await sdk.probeCount()
        XCTAssertEqual(springboardProbes, 0)

        _ = await handler.enrichWithMatchingSdkHierarchy(hierarchy(bundleId: "com.apple.springboard"))
        let uncachedSpringboardProbes = await sdk.probeCount()
        XCTAssertEqual(uncachedSpringboardProbes, 0)

        cache.update(cached)
        _ = await handler.enrichWithMatchingSdkHierarchy(hierarchy(bundleId: "com.example.other"))
        XCTAssertNil(cache.latest)
        let mismatchedProbes = await sdk.probeCount()
        XCTAssertEqual(mismatchedProbes, 0)
    }

    func testProbeRequiresForegroundAppState() async {
        let sdk = ProbeCountingSdkClient()
        let locator = RewriteFakeElementLocator()
        let handler = CommandHandler(
            elementLocator: locator,
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            sdkHierarchyClient: sdk
        )

        locator.appState = .runningBackgroundSuspended
        _ = await handler.enrichWithMatchingSdkHierarchy(hierarchy(bundleId: "com.example.app"))
        let backgroundProbes = await sdk.probeCount()
        XCTAssertEqual(backgroundProbes, 0)

        locator.appState = .runningForeground
        _ = await handler.enrichWithMatchingSdkHierarchy(hierarchy(bundleId: "com.example.app"))
        let foregroundProbes = await sdk.probeCount()
        XCTAssertEqual(foregroundProbes, 1)
    }

    private func hierarchy(bundleId: String) -> ViewHierarchy {
        ViewHierarchy(
            updatedAt: 1,
            packageName: bundleId,
            hierarchy: UIElementInfo(
                text: "Root", className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 393, bottom: 852)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
    }
}
