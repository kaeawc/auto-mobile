@testable import CtrlProxyRewrite
import Foundation
import XCTest

private actor FakeSdkHierarchyClient: SdkHierarchyFetching {
    private var serverInfo: SdkHierarchyServerInfo?
    private var networkErrorCalls = 0

    init(serverInfo: SdkHierarchyServerInfo?) {
        self.serverInfo = serverInfo
    }

    func networkErrorCallCount() -> Int {
        networkErrorCalls
    }

    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? { serverInfo }
    func isAvailable() async -> Bool { serverInfo != nil }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { serverInfo != nil }
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
                capabilities: ["network-fault-rules"]
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
        XCTAssertEqual(networkResponse?.ok, true)
        let callCount = await sdkClient.networkErrorCallCount()
        XCTAssertEqual(callCount, 1)
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
