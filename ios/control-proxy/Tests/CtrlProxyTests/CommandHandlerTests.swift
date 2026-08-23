@testable import CtrlProxy
import XCTest

private final class FakeVoiceOverStateProvider: VoiceOverStateProviding {
    var isRunning = false

    func isVoiceOverRunning() -> Bool {
        return isRunning
    }
}

private final class FakeVoiceOverToggle: VoiceOverToggling {
    private(set) var setCalls: [Bool] = []
    var errorToThrow: Error?

    func setVoiceOver(enabled: Bool) throws {
        setCalls.append(enabled)
        if let errorToThrow {
            throw errorToThrow
        }
    }
}

private final class FakeVoiceOverDefaultsReader: VoiceOverDefaultsReading {
    private var values: [String: Bool] = [:]

    func set(_ value: Bool, forKey key: String, inDomain domain: String) {
        values["\(domain).\(key)"] = value
    }

    func bool(forKey key: String, inDomain domain: String) -> Bool {
        return values["\(domain).\(key)"] ?? false
    }
}

final class CommandHandlerTests: XCTestCase {
    var fakeTimeProvider: FakeTimeProvider!
    var perfProvider: PerfProvider!
    var fakeElementLocator: FakeElementLocator!
    var fakeGesturePerformer: FakeGesturePerformer!
    var commandHandler: CommandHandler!

    override func setUp() {
        super.setUp()
        fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        fakeElementLocator = FakeElementLocator()
        fakeGesturePerformer = FakeGesturePerformer()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider
        )
    }

    override func tearDown() {
        perfProvider.clear()
        PerfProvider.resetInstance()
        super.tearDown()
    }

    private func handleRequest<T>(
        _ request: WebSocketRequest,
        as _: T.Type = T.self,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> T?
    {
        let response = commandHandler.handle(request)
        guard let typed = response as? T else {
            XCTFail("Expected \(T.self), got \(Swift.type(of: response))", file: file, line: line)
            return nil
        }
        return typed
    }

    private func makeHierarchy(packageName: String?) -> ViewHierarchy {
        ViewHierarchy(
            packageName: packageName,
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
    }

    private func makeSdkHierarchy(bundleId: String?, backgroundColor: String = "#123456FF") -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: 1000,
            bundleId: bundleId,
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            root: SdkViewNode(
                className: "UIView",
                bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 812),
                backgroundColor: backgroundColor
            )
        )
    }

    private func makeSdkHierarchyWithTabBarNode(bundleId: String?) -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: 1000,
            bundleId: bundleId,
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            root: SdkViewNode(
                className: "UIView",
                bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 812),
                children: [
                    SdkViewNode(
                        className: "UITabBarButtonLabel",
                        bounds: SdkBounds(left: 16, top: 740, right: 110, bottom: 770),
                        accessibilityLabel: "Discover",
                        isAccessibilityElement: true
                    ),
                ]
            )
        )
    }

    private func countClassName(_ className: String, in element: UIElementInfo?) -> Int {
        guard let element else { return 0 }
        let current = element.className == className ? 1 : 0
        return current + (element.node ?? []).reduce(0) { $0 + countClassName(className, in: $1) }
    }

    // MARK: - Network Mock Relay

    func testSetNetworkMockRulesRelaysRulesToSdkClient() {
        let fetcher = FakeSdkHierarchyFetcher()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher
        )
        let rules = [
            NetworkMockRuleDTO(
                mockId: "mock-1",
                host: "api\\.example\\.com",
                path: "^/v1/items",
                method: "GET",
                limit: 2,
                remaining: 2,
                statusCode: 500,
                responseHeaders: ["x-test": "yes"],
                responseBody: "{\"error\":\"mocked\"}",
                contentType: "application/json"
            ),
        ]

        let response = commandHandler.handle(WebSocketRequest.setNetworkMockRules(RequestSetNetworkMockRules(
            requestId: "mock-sync-1",
            rules: rules
        )))

        guard let typed = response as? SetNetworkMockRulesResponse else {
            XCTFail("Expected SetNetworkMockRulesResponse, got \(Swift.type(of: response))")
            return
        }
        XCTAssertEqual(typed.type, ResponseType.setNetworkMockRulesResult.rawValue)
        XCTAssertEqual(typed.requestId, "mock-sync-1")
        XCTAssertTrue(typed.ok)
        XCTAssertEqual(fetcher.setMockRulesCallCount, 1)
        XCTAssertEqual(fetcher.lastMockRules?.first?.mockId, "mock-1")
    }

    /// `rules` is now a decode-required field: a `set_network_mock_rules` command
    /// without it is rejected at the wire boundary rather than dispatched.
    func testSetNetworkMockRulesWithoutRulesFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"set_network_mock_rules","requestId":"mock-sync-missing"}"#)
        )
    }

    func testSetNetworkErrorSimulationRelaysConfigToSdkClient() {
        let fetcher = FakeSdkHierarchyFetcher()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher
        )

        let response = commandHandler.handle(WebSocketRequest.setNetworkErrorSimulation(RequestSetNetworkErrorSimulation(
            requestId: "sim-sync-1",
            enabled: true,
            errorType: "timeout",
            limit: 2,
            expiresAtEpochMs: 1_720_000_000_000
        )))

        guard let typed = response as? SetNetworkErrorSimulationResponse else {
            XCTFail("Expected SetNetworkErrorSimulationResponse, got \(Swift.type(of: response))")
            return
        }
        XCTAssertEqual(typed.type, ResponseType.setNetworkErrorSimulationResult.rawValue)
        XCTAssertEqual(typed.requestId, "sim-sync-1")
        XCTAssertTrue(typed.ok)
        XCTAssertEqual(fetcher.setNetworkErrorSimulationCallCount, 1)
        XCTAssertEqual(fetcher.lastNetworkErrorSimulation?.enabled, true)
        XCTAssertEqual(fetcher.lastNetworkErrorSimulation?.errorType, "timeout")
        XCTAssertEqual(fetcher.lastNetworkErrorSimulation?.limit, 2)
        XCTAssertEqual(fetcher.lastNetworkErrorSimulation?.expiresAtEpochMs, 1_720_000_000_000)
    }

    // MARK: - Hierarchy Request Tests

    func testRequestHierarchyIncludesPerfTiming() {
        // Configure fake hierarchy
        let testHierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Test Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeElementLocator.setHierarchy(testHierarchy)

        // Create request
        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-123"))

        // Simulate time passing during extraction
        fakeTimeProvider.setTime(1000)

        // Handle request and verify response includes perf timing
        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        XCTAssertEqual(hierarchyResponse.requestId, "test-123")
        XCTAssertNotNil(hierarchyResponse.data)
        XCTAssertEqual(hierarchyResponse.data?.packageName, "com.test.app")

        // Verify perf timing was captured
        // Note: The timing will be 0ms since we're using fakes, but the structure should be there
        XCTAssertNotNil(hierarchyResponse.perfTiming)
        XCTAssertEqual(hierarchyResponse.perfTiming?.name, "handleRequestHierarchy")
    }

    func testRequestHierarchyPerfTimingHasExtractionChild() {
        // Configure fake to simulate time passage
        fakeTimeProvider.setTime(1000)

        let testHierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Test Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeElementLocator.setHierarchy(testHierarchy)

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-456"))

        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        // Verify perf timing structure includes extraction child
        let perfTiming = hierarchyResponse.perfTiming
        XCTAssertNotNil(perfTiming)
        XCTAssertEqual(perfTiming?.name, "handleRequestHierarchy")

        // Should have extraction as a child
        let extractionChild = perfTiming?.children?.first { $0.name == "extraction" }
        XCTAssertNotNil(extractionChild, "Expected 'extraction' child in perf timing")
    }

    func testRequestHierarchyMergesCachedSdkHierarchyForForegroundBundle() {
        let cache = FakeSdkHierarchyCache()
        cache.update(makeSdkHierarchy(bundleId: "com.test.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyCache: cache
        )
        fakeElementLocator.setHierarchy(makeHierarchy(packageName: "com.test.app"))

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-sdk-match"))

        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        XCTAssertEqual(hierarchyResponse.data?.packageName, "com.test.app")
        XCTAssertEqual(hierarchyResponse.data?.hierarchy?.extras?["sdk.backgroundColor"], "#123456FF")
    }

    func testRequestHierarchySkipsCachedSdkHierarchyForDifferentForegroundBundle() {
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "dev.sdk.app"))

        let cache = FakeSdkHierarchyCache()
        cache.update(makeSdkHierarchy(bundleId: "dev.sdk.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher,
            sdkHierarchyCache: cache
        )
        fakeElementLocator.setHierarchy(makeHierarchy(packageName: "com.apple.Preferences"))

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-sdk-mismatch"))

        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        XCTAssertEqual(hierarchyResponse.data?.packageName, "com.apple.Preferences")
        XCTAssertNil(hierarchyResponse.data?.hierarchy?.extras?["sdk.backgroundColor"])
        XCTAssertEqual(fetcher.fetchServerInfoCallCount, 1)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 0)
        XCTAssertEqual(cache.clearCallCount, 1)
    }

    func testEnrichWithMatchingSdkHierarchyClearsForeignCacheWhenSdkServerIsDown() {
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(nil)

        let cache = FakeSdkHierarchyCache()
        cache.update(makeSdkHierarchyWithTabBarNode(bundleId: "dev.jasonpearson.automobile.Playground"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher,
            sdkHierarchyCache: cache
        )

        let enriched = commandHandler
            .enrichWithMatchingSdkHierarchy(makeHierarchy(packageName: "com.apple.Preferences"))

        XCTAssertEqual(enriched.packageName, "com.apple.Preferences")
        XCTAssertEqual(countClassName("UITabBarButtonLabel", in: enriched.hierarchy), 0)
        XCTAssertEqual(fetcher.fetchServerInfoCallCount, 1)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 0)
        XCTAssertEqual(cache.clearCallCount, 1)
    }

    func testEnrichWithCachedSdkHierarchyDoesNotProbeServerForForeignCache() {
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.apple.Preferences"))
        fetcher.setFreshHierarchy(makeSdkHierarchyWithTabBarNode(bundleId: "com.apple.Preferences"))

        let cache = FakeSdkHierarchyCache()
        cache.update(makeSdkHierarchyWithTabBarNode(bundleId: "dev.jasonpearson.automobile.Playground"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher,
            sdkHierarchyCache: cache
        )

        let enriched = commandHandler.enrichWithCachedSdkHierarchy(makeHierarchy(packageName: "com.apple.Preferences"))

        XCTAssertEqual(enriched.packageName, "com.apple.Preferences")
        XCTAssertEqual(countClassName("UITabBarButtonLabel", in: enriched.hierarchy), 0)
        XCTAssertEqual(fetcher.fetchServerInfoCallCount, 0)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 0)
        XCTAssertEqual(cache.clearCallCount, 1)
    }

    func testContextCheckedGesturePrefersCachedSdkHierarchyOverFreshFetch() {
        // A fresh hierarchy is available and the server bundle matches, but the gesture hot path
        // must never pay for the slow `/hierarchy/fresh` walk: it enriches from the cache only.
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.test.app"))
        fetcher.setFreshHierarchy(makeSdkHierarchy(bundleId: "com.test.app"))

        let cache = FakeSdkHierarchyCache()
        cache.update(makeSdkHierarchy(bundleId: "com.test.app"))

        let frameContext = FrameContext()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher,
            sdkHierarchyCache: cache,
            frameContext: frameContext
        )

        let hierarchy = makeHierarchy(packageName: "com.test.app")
        fakeElementLocator.setHierarchy(hierarchy)
        // Derive the expected context the same way the dispatch boundary will: cached enrichment.
        let expected = frameContext.context(for: commandHandler.enrichWithCachedSdkHierarchy(hierarchy))

        let response = handleRequest(
            WebSocketRequest.tapCoordinates(
                RequestTapCoordinates(requestId: "tap", x: 10, y: 20, frameContext: expected)
            ),
            as: WebSocketResponse.self
        )

        XCTAssertEqual(response?.success, true)
        XCTAssertEqual(fakeGesturePerformer.getTapHistory().count, 1)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 0)
    }

    func testRequestHierarchyFetchesFreshSdkHierarchyOnlyWhenServerBundleMatchesForeground() {
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.test.app"))
        fetcher.setFreshHierarchy(makeSdkHierarchy(bundleId: "com.test.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher
        )
        fakeElementLocator.setHierarchy(makeHierarchy(packageName: "com.test.app"))

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-sdk-fresh"))

        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        XCTAssertEqual(hierarchyResponse.data?.hierarchy?.extras?["sdk.backgroundColor"], "#123456FF")
        XCTAssertEqual(fetcher.fetchServerInfoCallCount, 1)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 1)
    }

    func testRequestHierarchyDoesNotFetchFreshSdkHierarchyWhenServerBundleDiffers() {
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "dev.sdk.app"))
        fetcher.setFreshHierarchy(makeSdkHierarchy(bundleId: "dev.sdk.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher
        )
        fakeElementLocator.setHierarchy(makeHierarchy(packageName: "com.apple.Preferences"))

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-sdk-no-fresh"))

        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        XCTAssertNil(hierarchyResponse.data?.hierarchy?.extras?["sdk.backgroundColor"])
        XCTAssertEqual(fetcher.fetchServerInfoCallCount, 1)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 0)
    }

    func testRequestHierarchyReplacesForeignCacheWithFreshForegroundHierarchy() {
        let fetcher = FakeSdkHierarchyFetcher()
        fetcher.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.apple.Preferences"))
        fetcher.setFreshHierarchy(makeSdkHierarchy(bundleId: "com.apple.Preferences", backgroundColor: "#ABCDEF01"))

        let cache = FakeSdkHierarchyCache()
        cache.update(makeSdkHierarchy(bundleId: "dev.sdk.app", backgroundColor: "#123456FF"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fetcher,
            sdkHierarchyCache: cache
        )
        fakeElementLocator.setHierarchy(makeHierarchy(packageName: "com.apple.Preferences"))

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-sdk-replace-cache"))

        guard let hierarchyResponse = handleRequest(request, as: HierarchyUpdateResponse.self) else { return }

        XCTAssertEqual(hierarchyResponse.data?.hierarchy?.extras?["sdk.backgroundColor"], "#ABCDEF01")
        XCTAssertEqual(cache.latest?.bundleId, "com.apple.Preferences")
        XCTAssertEqual(cache.updateCallCount, 2)
        XCTAssertEqual(cache.clearCallCount, 0)
        XCTAssertEqual(fetcher.fetchServerInfoCallCount, 1)
        XCTAssertEqual(fetcher.fetchFreshCallCount, 1)
    }

    func testRequestHierarchyError() {
        // Configure fake to throw error
        fakeElementLocator.setShouldThrow(CommandError.executionFailed("Test error"))

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "test-error"))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(errorResponse.success ?? true)
        XCTAssertNotNil(errorResponse.error)
        XCTAssertTrue(errorResponse.error?.contains("Test error") ?? false)
    }

    // MARK: - Tap Tests

    func testTapCoordinatesSuccess() {
        let request = WebSocketRequest.tapCoordinates(RequestTapCoordinates(
            requestId: "tap-123",
            x: 100,
            y: 200
        ))

        guard let tapResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(tapResponse.success, true)
        XCTAssertEqual(tapResponse.type, "tap_coordinates_result")

        // Verify tap was performed
        let tapHistory = fakeGesturePerformer.getTapHistory()
        XCTAssertEqual(tapHistory.count, 1)
        XCTAssertEqual(tapHistory.first?.x, 100)
        XCTAssertEqual(tapHistory.first?.y, 200)
    }

    /// `x`/`y` are now decode-required: a tap without coordinates is rejected at
    /// the wire boundary rather than dispatched.
    func testTapCoordinatesMissingParametersFailToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_tap_coordinates","requestId":"tap-error"}"#)
        )
    }

    // MARK: - Swipe Tests

    func testSwipeSuccess() {
        let request = WebSocketRequest.swipe(RequestSwipe(
            requestId: "swipe-123",
            x1: 100,
            y1: 200,
            x2: 100,
            y2: 500,

            duration: 300
        ))

        guard let swipeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(swipeResponse.success, true)

        // Verify swipe was performed
        let swipeHistory = fakeGesturePerformer.getSwipeHistory()
        XCTAssertEqual(swipeHistory.count, 1)
        XCTAssertEqual(swipeHistory.first?.startY, 200)
        XCTAssertEqual(swipeHistory.first?.endY, 500)
    }

    func testMultiFingerSwipeSuccess() {
        let request = WebSocketRequest.multiFingerSwipe(RequestMultiFingerSwipe(
            requestId: "test-multi-finger-swipe",
            x1: 100,
            y1: 600,
            x2: 100,
            y2: 200,
            fingerCount: 3,

            duration: 450,
            offset: 30
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(response.success ?? false)
        XCTAssertEqual(response.type, "multi_finger_swipe_result")
        XCTAssertEqual(response.requestId, "test-multi-finger-swipe")

        let history = fakeGesturePerformer.getMultiFingerSwipeHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.first?.startX, 100)
        XCTAssertEqual(history.first?.startY, 600)
        XCTAssertEqual(history.first?.endX, 100)
        XCTAssertEqual(history.first?.endY, 200)
        XCTAssertEqual(history.first?.fingerCount, 3)
        XCTAssertEqual(history.first?.fingerSpacing, 30)
        XCTAssertEqual(history.first?.duration ?? -1, 0.45, accuracy: 0.0001)
    }

    func testMultiFingerSwipePreservesFractionalSpacing() {
        let request = WebSocketRequest.multiFingerSwipe(RequestMultiFingerSwipe(
            requestId: "test-multi-finger-fractional-spacing",
            x1: 100,
            y1: 600,
            x2: 100,
            y2: 200,
            fingerCount: 3,

            duration: 450,
            offset: 30.5
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(response.success ?? false)
        XCTAssertEqual(response.type, "multi_finger_swipe_result")

        let history = fakeGesturePerformer.getMultiFingerSwipeHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.first?.fingerSpacing ?? -1, 30.5, accuracy: 0.0001)
    }

    func testTwoFingerSwipeUsesMultiFingerHandler() {
        let request = WebSocketRequest.twoFingerSwipe(RequestMultiFingerSwipe(
            requestId: "test-two-finger-swipe",
            x1: 10,
            y1: 20,
            x2: 30,
            y2: 40,

            duration: 300
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(response.success ?? false)
        XCTAssertEqual(response.type, "multi_finger_swipe_result")

        let history = fakeGesturePerformer.getMultiFingerSwipeHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.first?.fingerCount, 2)
        XCTAssertEqual(history.first?.fingerSpacing, 25)
    }

    func testMultiFingerSwipeFailureReturnsTypedError() {
        fakeGesturePerformer.setFailure(
            for: "multiFingerSwipe",
            error: GesturePerformer.GestureError.gestureFailed(
                "XCTest private multi-touch event synthesis classes are unavailable"
            )
        )
        let request = WebSocketRequest.multiFingerSwipe(RequestMultiFingerSwipe(
            requestId: "test-multi-finger-failure",
            x1: 100,
            y1: 600,
            x2: 100,
            y2: 200,
            fingerCount: 3
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(response.success ?? true)
        XCTAssertEqual(response.type, "multi_finger_swipe_result")
        XCTAssertTrue(response.error?
            .contains("XCTest private multi-touch event synthesis classes are unavailable") ?? false)
    }

    func testPinchSuccessForwardsRequestPayload() {
        let request = WebSocketRequest.pinch(RequestPinch(
            requestId: "test-pinch",
            centerX: 100,
            centerY: 200,
            distanceStart: 40,
            distanceEnd: 120,
            rotationDegrees: 15,

            duration: 700
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(response.success ?? false)
        XCTAssertEqual(response.type, "pinch_result")
        XCTAssertEqual(response.requestId, "test-pinch")
        // Default path is the private event-path synthesis (honors center).
        XCTAssertEqual(response.pinchPath, "event-path")

        let history = fakeGesturePerformer.getPinchHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.first?.centerX, 100)
        XCTAssertEqual(history.first?.centerY, 200)
        XCTAssertEqual(history.first?.distanceStart, 40)
        XCTAssertEqual(history.first?.distanceEnd, 120)
        XCTAssertEqual(history.first?.rotationDegrees, 15)
        XCTAssertEqual(history.first?.duration ?? -1, 0.7, accuracy: 0.0001)
    }

    func testPinchFailureReturnsTypedError() {
        fakeGesturePerformer.setFailure(
            for: "pinch",
            error: GesturePerformer.GestureError.gestureFailed("pinch synthesis failed")
        )
        let request = WebSocketRequest.pinch(RequestPinch(
            requestId: "test-pinch-failure",
            centerX: 100,
            centerY: 200,
            distanceStart: 40,
            distanceEnd: 120
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(response.success ?? true)
        XCTAssertEqual(response.type, "pinch_result")
        XCTAssertTrue(response.error?.contains("pinch synthesis failed") ?? false)
    }

    /// When the performer falls back to the public element-anchored pinch (private
    /// XCTest symbols unavailable), the success response must report the
    /// `element-anchored` path so callers know the center was not honored. See
    /// issue #2910.
    func testPinchFallbackSurfacesElementAnchoredPath() {
        fakeGesturePerformer.pinchPathToReturn = .elementAnchored
        let request = WebSocketRequest.pinch(RequestPinch(
            requestId: "test-pinch-fallback",
            centerX: 100,
            centerY: 200,
            distanceStart: 40,
            distanceEnd: 120
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(response.success ?? false)
        XCTAssertEqual(response.type, "pinch_result")
        XCTAssertEqual(response.pinchPath, "element-anchored")
    }

    // MARK: - Text Input Tests

    func testSetTextSuccess() {
        let request = WebSocketRequest.setText(RequestSetText(
            requestId: "text-123",
            text: "Hello World"
        ))

        guard let textResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(textResponse.success, true)

        // Verify text was typed
        let textHistory = fakeGesturePerformer.getTypeTextHistory()
        XCTAssertEqual(textHistory.count, 1)
        XCTAssertEqual(textHistory.first, "Hello World")
    }

    func testSetTextWithResourceId() {
        let request = WebSocketRequest.setText(RequestSetText(
            requestId: "text-456",
            text: "Field Text",
            resourceId: "input_field"
        ))

        guard let textResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(textResponse.success, true)

        // Verify setText was called (not typeText)
        let setTextHistory = fakeGesturePerformer.getSetTextHistory()
        XCTAssertEqual(setTextHistory.count, 1)
        XCTAssertEqual(setTextHistory.first?.text, "Field Text")
        XCTAssertEqual(setTextHistory.first?.resourceId, "input_field")
    }

    func testAppendTextAccumulatesSingleCharacterRequestsWithoutSetText() {
        for text in ["a", "b", "c"] {
            let request = WebSocketRequest.appendText(RequestAppendText(text: text))
            guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }
            XCTAssertEqual(response.success, true)
        }

        XCTAssertEqual(fakeGesturePerformer.getAppendTextHistory(), ["a", "b", "c"])
        XCTAssertEqual(fakeGesturePerformer.getFocusedFieldText(), "abc")
        XCTAssertTrue(fakeGesturePerformer.getSetTextHistory().isEmpty)
    }

    /// `text` is now decode-required for `request_set_text`.
    func testSetTextMissingTextFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_set_text","requestId":"text-err-1"}"#)
        )
    }

    func testSetTextTypeTextFailure() {
        fakeGesturePerformer.setFailure(
            for: "typeText",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "No keyboard focus"])
        )

        let request = WebSocketRequest.setText(RequestSetText(
            requestId: "text-fail-1",
            text: "Hello"
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testSetTextSetTextFailure() {
        fakeGesturePerformer.setFailure(
            for: "setText",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Element not found"])
        )

        let request = WebSocketRequest.setText(RequestSetText(
            requestId: "text-fail-2",
            text: "Hello",
            resourceId: "missing_field"
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testImeActionSuccess() {
        let request = WebSocketRequest.imeAction(RequestImeAction(
            requestId: "ime-1",
            action: "done"
        ))

        guard let imeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(imeResponse.success, true)
        XCTAssertEqual(imeResponse.type, "ime_action_result")
        XCTAssertEqual(fakeGesturePerformer.getImeActionHistory(), ["done"])
    }

    /// `action` is now decode-required for `request_ime_action`.
    func testImeActionMissingActionFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_ime_action","requestId":"ime-err-1"}"#)
        )
    }

    func testImeActionFailure() {
        fakeGesturePerformer.setFailure(
            for: "imeAction",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported"])
        )

        let request = WebSocketRequest.imeAction(RequestImeAction(
            requestId: "ime-fail-1",
            action: "previous"
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testSelectAllSuccess() {
        let request = WebSocketRequest.selectAll(RequestEnvelope(requestId: "sel-1"))

        guard let selResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(selResponse.success, true)
        XCTAssertEqual(selResponse.type, "select_all_result")
        XCTAssertEqual(fakeGesturePerformer.getSelectAllCallCount(), 1)
    }

    func testSelectAllFailure() {
        fakeGesturePerformer.setFailure(
            for: "selectAll",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "No focus"])
        )

        let request = WebSocketRequest.selectAll(RequestEnvelope(requestId: "sel-fail-1"))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testKeyboardDetectSuccess() {
        fakeGesturePerformer.setKeyboardOpen(true)
        let request = WebSocketRequest.keyboard(RequestKeyboard(
            requestId: "keyboard-detect",
            action: "detect"
        ))

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "keyboard_result")
        XCTAssertEqual(response.open, true)
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["detect"])
    }

    func testKeyboardOpenSuccess() {
        let request = WebSocketRequest.keyboard(RequestKeyboard(
            requestId: "keyboard-open",
            action: "open"
        ))

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.open, true)
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["open"])
    }

    func testKeyboardOpenFailureWhenKeyboardRemainsClosed() {
        fakeGesturePerformer.setNextKeyboardResult(false)
        let request = WebSocketRequest.keyboard(RequestKeyboard(
            requestId: "keyboard-open-failed",
            action: "open"
        ))

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.open, false)
        XCTAssertEqual(response.error, "Keyboard did not open")
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["open"])
    }

    func testKeyboardCloseSuccess() {
        fakeGesturePerformer.setKeyboardOpen(true)
        let request = WebSocketRequest.keyboard(RequestKeyboard(
            requestId: "keyboard-close",
            action: "close"
        ))

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.open, false)
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["close"])
    }

    func testKeyboardCloseFailureWhenKeyboardRemainsOpen() {
        fakeGesturePerformer.setNextKeyboardResult(true)
        let request = WebSocketRequest.keyboard(RequestKeyboard(
            requestId: "keyboard-close-failed",
            action: "close"
        ))

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.open, true)
        XCTAssertEqual(response.error, "Keyboard did not close")
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["close"])
    }

    /// `action` is now decode-required for `request_keyboard`.
    func testKeyboardMissingActionFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_keyboard","requestId":"keyboard-missing"}"#)
        )
    }

    func testClearTextWithoutResourceId() {
        let request = WebSocketRequest.clearText(RequestClearText(requestId: "clear-1"))

        guard let clearResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clearResponse.success, true)
        XCTAssertEqual(clearResponse.type, "clear_text_result")

        let clearHistory = fakeGesturePerformer.getClearTextHistory()
        XCTAssertEqual(clearHistory.count, 1)
        XCTAssertNil(clearHistory[0])
    }

    func testClearTextWithResourceId() {
        let request = WebSocketRequest.clearText(RequestClearText(
            requestId: "clear-2",
            resourceId: "text_input"
        ))

        guard let clearResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clearResponse.success, true)

        let clearHistory = fakeGesturePerformer.getClearTextHistory()
        XCTAssertEqual(clearHistory.count, 1)
        XCTAssertEqual(clearHistory[0], "text_input")
    }

    func testClearTextFailure() {
        fakeGesturePerformer.setFailure(
            for: "clearText",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "No focus"])
        )

        let request = WebSocketRequest.clearText(RequestClearText(requestId: "clear-fail-1"))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testClipboardGetSuccess() {
        fakeGesturePerformer.setClipboardContents("Copied text")

        let request = WebSocketRequest.clipboard(RequestClipboard(
            requestId: "clip-1",
            action: "get"
        ))

        guard let clipResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clipResponse.success, true)
        XCTAssertEqual(clipResponse.type, "clipboard_result")
        XCTAssertEqual(clipResponse.text, "Copied text")
    }

    func testClipboardCopySuccess() {
        let request = WebSocketRequest.clipboard(RequestClipboard(
            requestId: "clip-2",
            action: "copy",

            text: "To copy"
        ))

        guard let clipResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clipResponse.success, true)

        let history = fakeGesturePerformer.getClipboardHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].action, "copy")
        XCTAssertEqual(history[0].text, "To copy")
    }

    /// `action` is now decode-required for `request_clipboard`.
    func testClipboardMissingActionFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_clipboard","requestId":"clip-err-1"}"#)
        )
    }

    func testClipboardFailure() {
        fakeGesturePerformer.setFailure(
            for: "clipboard",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Clipboard error"])
        )

        let request = WebSocketRequest.clipboard(RequestClipboard(
            requestId: "clip-fail-1",
            action: "get"
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testClipboardGetRestrictedFailureSurfacesStaleShadowRisk() {
        fakeGesturePerformer.setFailure(
            for: "clipboard",
            error: GesturePerformer.GestureError.clipboardReadUnavailable
        )

        let request = WebSocketRequest.clipboard(RequestClipboard(
            requestId: "clip-restricted-1",
            action: "get"
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
        XCTAssertEqual(errorResponse.type, "clipboard_result")
        XCTAssertEqual(
            errorResponse.error,
            "Clipboard read unavailable; live pasteboard access may be restricted, so shadow clipboard content was not returned"
        )
    }

    // MARK: - Node Action Tests

    /// VoiceOver activation (issue #2857) rides `request_action` with action "activate"
    /// and an accessibility label. The command must decode and reach `performAction`
    /// with the label preserved, replying `action_result`.
    func testActionActivateByLabelReachesPerformAction() {
        let request = WebSocketRequest.action(RequestAction(
            requestId: "act-activate-1",
            action: "activate",
            resourceId: nil,
            label: "Submit"
        ))

        guard let actionResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(actionResponse.success, true)
        XCTAssertEqual(actionResponse.type, "action_result")

        let history = fakeGesturePerformer.getActionHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].action, "activate")
        XCTAssertEqual(history[0].label, "Submit")
        XCTAssertNil(history[0].resourceId)
    }

    /// `request_action` decoded straight from the wire the TS client now emits for
    /// VoiceOver long-press activation.
    func testActionLongPressDecodesFromWire() throws {
        let request = try decodeWebSocketRequest(
            #"{"type":"request_action","requestId":"act-lp-1","action":"long_press","label":"Row"}"#
        )

        guard let actionResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(actionResponse.success, true)

        let history = fakeGesturePerformer.getActionHistory()
        XCTAssertEqual(history[0].action, "long_press")
        XCTAssertEqual(history[0].label, "Row")
    }

    // MARK: - Device Control Tests

    func testPressHomeSuccess() {
        let request = WebSocketRequest.pressHome(RequestEnvelope(requestId: "home-123"))

        guard let homeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(homeResponse.success, true)
        XCTAssertEqual(homeResponse.type, "press_home_result")
        XCTAssertEqual(fakeGesturePerformer.getPressHomeCallCount(), 1)

        // Verify perf timing is collected for press home operations
        guard let perfTimings = perfProvider.flush() else {
            XCTFail("Expected perf timing data from handlePressHome")
            return
        }
        XCTAssertEqual(perfTimings.count, 1)
        XCTAssertEqual(perfTimings[0].name, "handlePressHome")
        let childNames = perfTimings[0].children?.map { $0.name } ?? []
        XCTAssertEqual(childNames, ["pressHome", "switchForegroundApp", "updateApplication"])
    }

    func testPressBackSuccess() {
        let request = WebSocketRequest.pressBack(RequestEnvelope(requestId: "back-123"))

        guard let backResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(backResponse.success, true)
        XCTAssertEqual(backResponse.type, "press_back_result")
        XCTAssertEqual(fakeGesturePerformer.getPressBackCallCount(), 1)

        guard let perfTimings = perfProvider.flush() else {
            XCTFail("Expected perf timing data from handlePressBack")
            return
        }
        XCTAssertEqual(perfTimings.count, 1)
        XCTAssertEqual(perfTimings[0].name, "handlePressBack")
        let childNames = perfTimings[0].children?.map { $0.name } ?? []
        XCTAssertEqual(childNames, ["pressBack"])
    }

    func testPressButtonBackSuccess() {
        let request = WebSocketRequest.pressButton(RequestPressButton(
            requestId: "button-back",
            action: "back"
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["back"])
        XCTAssertEqual(fakeElementLocator.switchedBundleIds, [])
        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, [])
    }

    func testPressButtonHomeSwitchesToSpringBoard() {
        let request = WebSocketRequest.pressButton(RequestPressButton(
            requestId: "button-home",
            action: "home"
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["home"])
        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.apple.springboard"])
        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.apple.springboard"])
    }

    func testPressButtonHardwareButtonDoesNotSwitchToSpringBoard() {
        let request = WebSocketRequest.pressButton(RequestPressButton(
            requestId: "button-volume-up",
            action: "volume_up"
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["volume_up"])
        XCTAssertEqual(fakeElementLocator.switchedBundleIds, [])
        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, [])
    }

    func testPressButtonPowerDoesNotSwitchToSpringBoard() {
        let request = WebSocketRequest.pressButton(RequestPressButton(
            requestId: "button-power",
            action: "power"
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["power"])
        XCTAssertEqual(fakeElementLocator.switchedBundleIds, [])
        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, [])
    }

    func testLaunchAppSuccess() {
        // Default: app not running, no coldBoot → full launch
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-123",
            bundleId: "com.apple.Preferences"
        ))

        guard let launchResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(launchResponse.success, true)
        XCTAssertEqual(launchResponse.type, "launch_app_result")
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), ["com.apple.Preferences"])

        // Verify perf timing is collected for launch operations
        guard let perfTimings = perfProvider.flush() else {
            XCTFail("Expected perf timing data from handleLaunchApp")
            return
        }
        XCTAssertEqual(perfTimings.count, 1)
        XCTAssertEqual(perfTimings[0].name, "handleLaunchApp")
        let childNames = perfTimings[0].children?.map { $0.name } ?? []
        XCTAssertEqual(
            childNames,
            ["checkAppState", "launchApp", "switchForegroundApp", "updateApplication", "awaitForeground"]
        )
    }

    func testLaunchAppUsesActivateWhenRunningBackground() {
        fakeElementLocator.getAppStateResult = .runningBackground
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-activate",
            bundleId: "com.example.app"
        ))

        guard let launchResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(launchResponse.success, true)
        // Should activate, not launch
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), [])
        XCTAssertEqual(fakeGesturePerformer.activateAppHistory, ["com.example.app"])

        guard let perfTimings = perfProvider.flush() else {
            XCTFail("Expected perf timing data")
            return
        }
        let childNames = perfTimings[0].children?.map { $0.name } ?? []
        XCTAssertEqual(
            childNames,
            ["checkAppState", "activateApp", "switchForegroundApp", "updateApplication", "awaitForeground"]
        )
    }

    func testLaunchAppUsesActivateWhenRunningForeground() {
        fakeElementLocator.getAppStateResult = .runningForeground
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-fg",
            bundleId: "com.example.app"
        ))

        _ = commandHandler.handle(request)

        // Should activate (no-op), not launch
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), [])
        XCTAssertEqual(fakeGesturePerformer.activateAppHistory, ["com.example.app"])

        // awaitForeground should be skipped — app was already foreground
        guard let perfTimings = perfProvider.flush() else {
            XCTFail("Expected perf timing data")
            return
        }
        let childNames = perfTimings[0].children?.map { $0.name } ?? []
        XCTAssertEqual(childNames, ["checkAppState", "activateApp", "switchForegroundApp", "updateApplication"])
        XCTAssertFalse(childNames.contains("awaitForeground"))
    }

    func testLaunchAppColdBootTerminatesThenLaunches() {
        fakeElementLocator.getAppStateResult = .runningForeground
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-cold",
            bundleId: "com.example.app",
            coldBoot: true
        ))

        _ = commandHandler.handle(request)

        // Cold boot should terminate then launch, not activate
        XCTAssertEqual(fakeGesturePerformer.getAppTerminateHistory(), ["com.example.app"])
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), ["com.example.app"])
        XCTAssertEqual(fakeGesturePerformer.activateAppHistory, [])

        guard let perfTimings = perfProvider.flush() else {
            XCTFail("Expected perf timing data")
            return
        }
        let childNames = perfTimings[0].children?.map { $0.name } ?? []
        XCTAssertEqual(
            childNames,
            [
                "checkAppState",
                "terminateApp",
                "launchApp",
                "switchForegroundApp",
                "updateApplication",
                "awaitForeground",
            ]
        )
    }

    func testLaunchAppColdBootNotRunningSkipsTerminate() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-cold-nr",
            bundleId: "com.example.app",
            coldBoot: true
        ))

        _ = commandHandler.handle(request)

        // Not running → no terminate needed, just launch
        XCTAssertEqual(fakeGesturePerformer.getAppTerminateHistory(), [])
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), ["com.example.app"])
    }

    // MARK: - Explicit State Transition Tests

    func testLaunchAppSwitchesForegroundApp() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-switch",
            bundleId: "com.example.app"
        ))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.example.app"])
    }

    func testLaunchAppUpdatesGesturePerformer() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-gesture",
            bundleId: "com.example.app"
        ))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.example.app"])
    }

    func testLaunchAppAwaitsForegroundState() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-await",
            bundleId: "com.example.app"
        ))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.awaitStateCalls.count, 1)
        XCTAssertEqual(fakeElementLocator.awaitStateCalls.first?.bundleId, "com.example.app")
        XCTAssertEqual(fakeElementLocator.awaitStateCalls.first?.expectedState, .foreground)
    }

    func testPressHomeSwitchesToSpringboard() {
        let request = WebSocketRequest.pressHome(RequestEnvelope(requestId: "home-switch"))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.apple.springboard"])
    }

    func testPressHomeUpdatesGesturePerformer() {
        let request = WebSocketRequest.pressHome(RequestEnvelope(requestId: "home-gesture"))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.apple.springboard"])
    }

    // MARK: - Recent Apps Tests

    func testRecentAppsSuccess() {
        let request = WebSocketRequest.recentApps(RequestEnvelope(requestId: "recents-123"))

        guard let recentsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(recentsResponse.success, true)
        XCTAssertEqual(recentsResponse.type, "recent_apps_result")
        XCTAssertEqual(fakeGesturePerformer.getOpenRecentAppsCallCount(), 1)
    }

    func testRecentAppsReturnsFailureWhenSwitcherIsNotVerified() {
        fakeGesturePerformer.setOpenRecentAppsResult(false)
        let request = WebSocketRequest.recentApps(RequestEnvelope(requestId: "recents-not-visible"))

        guard let recentsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(recentsResponse.success, false)
        XCTAssertEqual(recentsResponse.type, "recent_apps_result")
        XCTAssertEqual(recentsResponse.error, "iOS App Switcher did not appear after recent apps invocation")
        XCTAssertEqual(fakeGesturePerformer.getOpenRecentAppsCallCount(), 1)
        XCTAssertTrue(fakeElementLocator.switchedBundleIds.isEmpty)
        XCTAssertTrue(fakeGesturePerformer.updateApplicationHistory.isEmpty)
    }

    func testRecentAppsSwitchesToSpringboard() {
        let request = WebSocketRequest.recentApps(RequestEnvelope(requestId: "recents-switch"))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.apple.springboard"])
    }

    func testRecentAppsUpdatesGesturePerformer() {
        let request = WebSocketRequest.recentApps(RequestEnvelope(requestId: "recents-gesture"))

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.apple.springboard"])
    }

    // MARK: - Shake Tests

    func testShakeSuccess() {
        let request = WebSocketRequest.shake(RequestEnvelope(requestId: "shake-123"))

        guard let shakeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(shakeResponse.success, true)
        XCTAssertEqual(shakeResponse.type, "shake_result")
        XCTAssertEqual(fakeGesturePerformer.getShakeCallCount(), 1)
    }

    // MARK: - Rotate Tests

    func testRotateToLandscapeSuccess() {
        let request = WebSocketRequest.rotate(RequestRotate(
            requestId: "rotate-123",
            orientation: "landscape"
        ))

        guard let rotateResponse = handleRequest(request, as: RotateResponse.self) else { return }

        XCTAssertTrue(rotateResponse.success)
        XCTAssertEqual(rotateResponse.type, "rotate_result")
        XCTAssertEqual(rotateResponse.previousOrientation, "portrait")
        XCTAssertEqual(rotateResponse.currentOrientation, "landscape")
        XCTAssertEqual(rotateResponse.value, 1)
        XCTAssertTrue(rotateResponse.rotationPerformed)
    }

    func testRotateToPortraitWhenAlreadyPortrait() {
        let request = WebSocketRequest.rotate(RequestRotate(
            requestId: "rotate-noop",
            orientation: "portrait"
        ))

        guard let rotateResponse = handleRequest(request, as: RotateResponse.self) else { return }

        XCTAssertTrue(rotateResponse.success)
        XCTAssertEqual(rotateResponse.previousOrientation, "portrait")
        XCTAssertEqual(rotateResponse.currentOrientation, "portrait")
        XCTAssertEqual(rotateResponse.value, 0)
        XCTAssertFalse(rotateResponse.rotationPerformed)
    }

    /// `orientation` is now decode-required for `request_rotate`.
    func testRotateMissingOrientationFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_rotate","requestId":"rotate-missing"}"#)
        )
    }

    // MARK: - ObjCExceptionError Propagation Tests

    func testTapWithObjCExceptionReturnsErrorResponse() {
        fakeGesturePerformer.setFailure(
            for: "tap",
            error: ObjCExceptionError(name: "NSRangeException", reason: "index 5 beyond bounds [0..3]")
        )

        let request = WebSocketRequest.tapCoordinates(RequestTapCoordinates(
            requestId: "tap-objc-err",
            x: 100,
            y: 200
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertNotNil(errorResponse.error)
        XCTAssertTrue(errorResponse.error?.contains("NSRangeException") ?? false)
        XCTAssertTrue(errorResponse.error?.contains("index 5 beyond bounds") ?? false)
    }

    func testSwipeWithObjCExceptionReturnsErrorResponse() {
        fakeGesturePerformer.setFailure(
            for: "swipe",
            error: ObjCExceptionError(name: "NSInternalInconsistencyException", reason: "Invalid snapshot")
        )

        let request = WebSocketRequest.swipe(RequestSwipe(
            requestId: "swipe-objc-err",
            x1: 100,
            y1: 200,
            x2: 100,
            y2: 500,

            duration: 300
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("NSInternalInconsistencyException") ?? false)
        XCTAssertTrue(errorResponse.error?.contains("Invalid snapshot") ?? false)
    }

    func testHierarchyWithObjCExceptionReturnsErrorResponse() {
        fakeElementLocator.setShouldThrow(
            ObjCExceptionError(name: "NSGenericException", reason: "Stale element reference")
        )

        let request = WebSocketRequest.requestHierarchy(RequestHierarchy(requestId: "hier-objc-err"))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(errorResponse.success ?? true)
        XCTAssertTrue(errorResponse.error?.contains("NSGenericException") ?? false)
        XCTAssertTrue(errorResponse.error?.contains("Stale element reference") ?? false)
    }

    func testLaunchAppWithObjCExceptionReturnsErrorResponse() {
        fakeElementLocator.getAppStateResult = .notRunning
        fakeGesturePerformer.setFailure(
            for: "launchApp",
            error: ObjCExceptionError(name: "NSInvalidArgumentException", reason: "App not installed")
        )

        let request = WebSocketRequest.launchApp(RequestLaunchApp(
            requestId: "launch-objc-err",
            bundleId: "com.missing.app"
        ))

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("NSInvalidArgumentException") ?? false)
        XCTAssertTrue(errorResponse.error?.contains("App not installed") ?? false)
    }

    // MARK: - Reset Permissions Tests

    func testResetPermissionsAllExpandsToEveryResettablePrivacyResource() {
        XCTAssertEqual(
            GesturePerformer.expandedPrivacyResourceNames(for: "all"),
            [
                "camera",
                "photos",
                "microphone",
                "contacts",
                "location",
                "calendar",
                "reminders",
                "media-library",
                "homekit",
                "focus",
                "local-network",
                "bluetooth",
                "keyboard-network",
                "health",
                "user-tracking",
            ]
        )
        // Each newly added XCUIProtectedResource name is a recognized (aliasable)
        // reset resource, so it expands to itself rather than returning nil.
        for name in ["homekit", "focus", "local-network", "bluetooth", "keyboard-network", "health", "user-tracking"] {
            XCTAssertEqual(
                GesturePerformer.expandedPrivacyResourceNames(for: name),
                [name],
                "\(name) should be a recognized resettable resource"
            )
        }
        XCTAssertEqual(GesturePerformer.expandedPrivacyResourceNames(for: "photos-add"), ["photos-add"])
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "photos-add"), "photos")
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "contacts-limited"), "contacts")
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "location-always"), "location")
        XCTAssertNil(GesturePerformer.expandedPrivacyResourceNames(for: "siri"))
    }

    func testResetPermissionsForwardsResourcesToGesturePerformer() {
        let request = WebSocketRequest.resetPermissions(RequestResetPermissions(
            requestId: "reset-1",
            bundleId: "com.example.app",
            permissions: ["camera", "photos"]
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "reset_permissions_result")
        XCTAssertEqual(response.requestId, "reset-1")
        XCTAssertEqual(response.success, true)
        let history = fakeGesturePerformer.getResetAuthorizationsHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.first?.bundleId, "com.example.app")
        XCTAssertEqual(history.first?.resources, ["camera", "photos"])
    }

    func testResetPermissionsSurfacesRunnerErrorAsStructuredFailure() {
        fakeGesturePerformer.setFailure(
            for: "resetAuthorizations",
            error: CommandError.invalidParameter("permission", "siri")
        )

        let request = WebSocketRequest.resetPermissions(RequestResetPermissions(
            requestId: "reset-err",
            bundleId: "com.example.app",
            permissions: ["siri"]
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "reset_permissions_result")
        XCTAssertEqual(response.success, false)
        XCTAssertTrue(response.error?.contains("siri") ?? false, "error should name the unmapped resource")
    }

    // MARK: - Unknown Command Tests

    /// An unrecognized command `type` is now rejected at the decode boundary
    /// rather than dispatched: the enum has no case for it, so decoding throws.
    /// The thrown error must carry the exact "Unknown command type: <type>" text
    /// so `WebSocketServer` surfaces it on the wire and the TS client's
    /// `rewriteUnknownCommandError` can flag a stale runner (a generic
    /// `DecodingError` would lose that diagnostic).
    func testUnknownCommandFailsToDecodeWithDiagnosticText() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"unknown_command","requestId":"unknown-123"}"#)
        ) { error in
            XCTAssertEqual(
                (error as? CommandError)?.errorDescription,
                "Unknown command type: unknown_command"
            )
            XCTAssertEqual(error.localizedDescription, "Unknown command type: unknown_command")
        }
    }

    // MARK: - VoiceOver State Tests

    func testGetVoiceOverStateReturnsResponse() {
        let request = WebSocketRequest.getVoiceOverState(RequestEnvelope(requestId: "voiceover-123"))

        guard let voResponse = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        XCTAssertEqual(voResponse.requestId, "voiceover-123")
        XCTAssertEqual(voResponse.type, "voiceover_state_result")
        XCTAssertTrue(voResponse.success)
        // enabled is false in SPM tests (macOS, no UIAccessibility)
        XCTAssertFalse(voResponse.enabled)
        XCTAssertNotNil(voResponse.totalTimeMs)
    }

    private func makeHandler(
        stateProvider: FakeVoiceOverStateProvider,
        toggle: FakeVoiceOverToggle
    )
        -> CommandHandler
    {
        return CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            voiceOverStateProvider: stateProvider,
            voiceOverToggle: toggle
        )
    }

    func testSetVoiceOverStateTogglesWhenStateDiffers() {
        let stateProvider = FakeVoiceOverStateProvider()
        stateProvider.isRunning = false
        let toggle = FakeVoiceOverToggle()
        commandHandler = makeHandler(stateProvider: stateProvider, toggle: toggle)

        let request = WebSocketRequest.setVoiceOverState(
            RequestSetVoiceOverState(requestId: "vo-set-1", enabled: true))
        guard let response = handleRequest(request, as: VoiceOverSetResponse.self) else { return }

        XCTAssertEqual(response.requestId, "vo-set-1")
        XCTAssertEqual(response.type, "voiceover_set_result")
        XCTAssertTrue(response.success)
        XCTAssertNil(response.error)
        XCTAssertEqual(toggle.setCalls, [true])
    }

    func testSetVoiceOverStateIsIdempotentNoOpWhenAlreadyInTargetState() {
        let stateProvider = FakeVoiceOverStateProvider()
        stateProvider.isRunning = true
        let toggle = FakeVoiceOverToggle()
        commandHandler = makeHandler(stateProvider: stateProvider, toggle: toggle)

        let request = WebSocketRequest.setVoiceOverState(
            RequestSetVoiceOverState(requestId: "vo-set-2", enabled: true))
        guard let response = handleRequest(request, as: VoiceOverSetResponse.self) else { return }

        XCTAssertTrue(response.success)
        // Load-bearing: no tap when already on, or VoiceOver's double-tap idiom
        // would reinterpret the tap as an activation (#2501).
        XCTAssertEqual(toggle.setCalls, [], "must not tap when already in target state")
    }

    func testSetVoiceOverStateSurfacesToggleFailureAsUnsuccessful() {
        let stateProvider = FakeVoiceOverStateProvider()
        stateProvider.isRunning = false
        let toggle = FakeVoiceOverToggle()
        toggle.errorToThrow = VoiceOverToggleError.switchNotFound
        commandHandler = makeHandler(stateProvider: stateProvider, toggle: toggle)

        let request = WebSocketRequest.setVoiceOverState(
            RequestSetVoiceOverState(requestId: "vo-set-3", enabled: true))
        guard let response = handleRequest(request, as: VoiceOverSetResponse.self) else { return }

        XCTAssertFalse(response.success)
        XCTAssertNotNil(response.error)
        XCTAssertEqual(toggle.setCalls, [true])
    }

    func testGetVoiceOverStateWithNilRequestId() {
        let request = WebSocketRequest.getVoiceOverState(RequestEnvelope())

        guard let voResponse = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        XCTAssertNil(voResponse.requestId)
        XCTAssertEqual(voResponse.type, "voiceover_state_result")
        XCTAssertTrue(voResponse.success)
    }

    func testGetVoiceOverStateReportsLivenessProviderState() {
        let voiceOverStateProvider = FakeVoiceOverStateProvider()
        voiceOverStateProvider.isRunning = true
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            voiceOverStateProvider: voiceOverStateProvider
        )

        let request = WebSocketRequest.getVoiceOverState(RequestEnvelope(requestId: "voiceover-live"))

        guard let response = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        XCTAssertTrue(response.enabled)
    }

    func testGetVoiceOverStateDoesNotTreatPreferenceBackedUIKitStateAsLiveness() {
        let voiceOverStateProvider = FakeVoiceOverStateProvider()
        voiceOverStateProvider.isRunning = false
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            voiceOverStateProvider: voiceOverStateProvider
        )

        let request = WebSocketRequest.getVoiceOverState(RequestEnvelope(requestId: "voiceover-stopped"))

        guard let response = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        XCTAssertFalse(response.enabled)
    }

    func testDefaultVoiceOverStateProviderReadsRunningKey() {
        let defaultsReader = FakeVoiceOverDefaultsReader()
        defaultsReader.set(true, forKey: "VOTIsRunningKey", inDomain: "com.apple.Accessibility")

        let provider = DefaultVoiceOverStateProvider(defaultsReader: defaultsReader)

        XCTAssertTrue(provider.isVoiceOverRunning())
    }

    func testDefaultVoiceOverStateProviderTreatsMissingRunningKeyAsStopped() {
        let provider = DefaultVoiceOverStateProvider(defaultsReader: FakeVoiceOverDefaultsReader())

        XCTAssertFalse(provider.isVoiceOverRunning())
    }

    func testGetVoiceOverStateIsEncodable() throws {
        let request = WebSocketRequest.getVoiceOverState(RequestEnvelope(requestId: "encode-test"))

        guard let voResponse = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        // Verify the response can be JSON encoded (required for WebSocket serialization)
        let encoder = JSONEncoder()
        let data = try encoder.encode(voResponse)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertNotNil(json)
        XCTAssertEqual(json?["type"] as? String, "voiceover_state_result")
        XCTAssertEqual(json?["requestId"] as? String, "encode-test")
        XCTAssertEqual(json?["success"] as? Bool, true)
        XCTAssertNotNil(json?["enabled"])
    }

    // MARK: - Highlight Tests

    func testAddHighlightUsesSdkBridgeWhenForegroundAppHasSdk() {
        let sdkClient = FakeSdkHierarchyFetcher()
        sdkClient.addHighlightResult = .rendered
        fakeElementLocator.foregroundBundleId = "com.test.app"
        sdkClient.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.test.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: sdkClient
        )
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50)
        )
        let request = WebSocketRequest.addHighlight(RequestAddHighlight(
            requestId: "highlight-request",
            id: "highlight-1",
            shape: shape
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "highlight_response")
        XCTAssertEqual(response.requestId, "highlight-request")
        XCTAssertEqual(response.success, true)
        XCTAssertNil(response.error)
        XCTAssertEqual(sdkClient.addHighlightCallCount, 1)
        XCTAssertEqual(sdkClient.lastHighlight?.id, "highlight-1")
        XCTAssertEqual(sdkClient.lastHighlight?.shape.type, "box")
    }

    func testAddHighlightReturnsSdkRequiredErrorWhenNoSdkClient() {
        fakeElementLocator.foregroundBundleId = "com.apple.reminders"
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider
        )
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50)
        )
        let request = WebSocketRequest.addHighlight(RequestAddHighlight(
            requestId: "highlight-request",
            id: "highlight-1",
            shape: shape
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "highlight_response")
        XCTAssertEqual(response.requestId, "highlight-request")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(
            response.error,
            "Highlighting com.apple.reminders requires the AutoMobile SDK embedded in the target app; "
                + "iOS cannot draw an overlay into another app from the test runner."
        )
    }

    func testAddHighlightReturnsSdkRequiredErrorWhenSdkTargetsDifferentBundle() {
        let sdkClient = FakeSdkHierarchyFetcher()
        sdkClient.addHighlightResult = .rendered
        fakeElementLocator.foregroundBundleId = "com.apple.reminders"
        sdkClient.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.other.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: sdkClient
        )
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50)
        )
        let request = WebSocketRequest.addHighlight(RequestAddHighlight(
            requestId: "highlight-request",
            id: "highlight-1",
            shape: shape
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "highlight_response")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(sdkClient.addHighlightCallCount, 0)
        XCTAssertEqual(
            response.error,
            "Highlighting com.apple.reminders requires the AutoMobile SDK embedded in the target app; "
                + "iOS cannot draw an overlay into another app from the test runner."
        )
    }

    func testAddHighlightReturnsSdkRequiredErrorWhenSdkBridgeUnreachable() {
        let sdkClient = FakeSdkHierarchyFetcher()
        sdkClient.addHighlightResult = .unavailable
        fakeElementLocator.foregroundBundleId = "com.test.app"
        sdkClient.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.test.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: sdkClient
        )
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50)
        )
        let request = WebSocketRequest.addHighlight(RequestAddHighlight(
            requestId: "highlight-request",
            id: "highlight-1",
            shape: shape
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "highlight_response")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(sdkClient.addHighlightCallCount, 1)
        XCTAssertEqual(
            response.error,
            "Highlighting com.test.app requires the AutoMobile SDK embedded in the target app; "
                + "iOS cannot draw an overlay into another app from the test runner."
        )
    }

    func testAddHighlightReportsRejectionWhenSdkBridgeDeclines() {
        // Issue #2682: when the SDK bridge owns the foreground app but declines the
        // highlight (e.g. missing source dimensions), report that precise reason
        // rather than the misleading "SDK not embedded" error — the SDK *is* embedded.
        let sdkClient = FakeSdkHierarchyFetcher()
        sdkClient.addHighlightResult = .rejected
        fakeElementLocator.foregroundBundleId = "com.test.app"
        sdkClient.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.test.app"))
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: sdkClient
        )
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50)
        )
        let request = WebSocketRequest.addHighlight(RequestAddHighlight(
            requestId: "highlight-request",
            id: "highlight-1",
            shape: shape
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "highlight_response")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(sdkClient.addHighlightCallCount, 1)
        XCTAssertEqual(
            response.error,
            "Target app SDK highlight bridge rejected the highlight "
                + "(missing source dimensions or invalid shape)."
        )
    }

    func testAddHighlightRequiresShape() {
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider
        )
        let request = WebSocketRequest.addHighlight(RequestAddHighlight(
            requestId: "highlight-request",
            id: "highlight-1"
        ))

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.type, "highlight_response")
        XCTAssertEqual(response.requestId, "highlight-request")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.error, "add_highlight requires a shape")
    }
}

// MARK: - Storage Command Tests

final class StorageCommandHandlerTests: XCTestCase {
    var fakeTimeProvider: FakeTimeProvider!
    var perfProvider: PerfProvider!
    var fakeElementLocator: FakeElementLocator!
    var fakeGesturePerformer: FakeGesturePerformer!
    var fakeStorage: FakeStorageInspecting!
    var commandHandler: CommandHandler!

    override func setUp() {
        super.setUp()
        fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        fakeElementLocator = FakeElementLocator()
        fakeGesturePerformer = FakeGesturePerformer()
        fakeStorage = FakeStorageInspecting()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            storageInspector: fakeStorage
        )
    }

    override func tearDown() {
        perfProvider.clear()
        PerfProvider.resetInstance()
        super.tearDown()
    }

    private func handleRequest<T>(
        _ request: WebSocketRequest,
        as _: T.Type = T.self,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> T?
    {
        handleRequest(commandHandler, request, as: T.self, file: file, line: line)
    }

    private func handleRequest<T>(
        _ handler: CommandHandler,
        _ request: WebSocketRequest,
        as _: T.Type = T.self,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> T?
    {
        let response = handler.handle(request)
        guard let typed = response as? T else {
            XCTFail("Expected \(T.self), got \(Swift.type(of: response))", file: file, line: line)
            return nil
        }
        return typed
    }

    // MARK: - List Preference Files

    func testListPreferenceFilesReturnsSuites() {
        fakeStorage.setSuites([
            StorageSuiteInfo(name: "Standard", displayName: "Standard", entryCount: 5),
            StorageSuiteInfo(name: "group.com.example", displayName: "group.com.example", entryCount: 3),
        ])

        let request = WebSocketRequest.listPreferenceFiles(RequestEnvelope(requestId: "list-1"))
        guard let filesResponse = handleRequest(request, as: StorageFilesResponse.self) else { return }

        XCTAssertEqual(filesResponse.requestId, "list-1")
        XCTAssertTrue(filesResponse.success)
        XCTAssertEqual(filesResponse.files?.count, 2)
        XCTAssertEqual(filesResponse.files?[0].displayName, "Standard")
        XCTAssertEqual(filesResponse.files?[0].path, "Standard")
        XCTAssertEqual(filesResponse.files?[0].entryCount, 5)
        XCTAssertEqual(filesResponse.files?[1].name, "group.com.example")
        XCTAssertEqual(filesResponse.files?[1].path, "group.com.example")
        XCTAssertEqual(fakeStorage.listSuitesCallCount, 1)
    }

    // MARK: - Get Preferences

    func testGetPreferencesReturnsEntries() {
        fakeStorage.setEntries([
            StorageEntry(key: "theme", value: "dark", type: "STRING"),
            StorageEntry(key: "count", value: "42", type: "INT"),
        ])

        let request = WebSocketRequest.getPreferences(RequestGetPreferences(requestId: "get-all-1"))
        guard let entriesResponse = handleRequest(request, as: StorageEntriesResponse.self) else { return }

        XCTAssertTrue(entriesResponse.success)
        XCTAssertEqual(entriesResponse.entries?.count, 2)
        XCTAssertEqual(entriesResponse.entries?[0].key, "theme")
        // suiteName should be nil for Standard (no fileName provided)
        XCTAssertEqual(fakeStorage.getEntriesHistory, [nil])
    }

    func testGetPreferencesWithCustomSuite() {
        fakeStorage.setEntries([
            StorageEntry(key: "setting", value: "on", type: "STRING"),
        ], forSuite: "com.example.settings")

        let request = WebSocketRequest.getPreferences(RequestGetPreferences(
            requestId: "get-all-2",
            fileName: "com.example.settings"
        ))
        guard let entriesResponse = handleRequest(request, as: StorageEntriesResponse.self) else { return }

        XCTAssertTrue(entriesResponse.success)
        XCTAssertEqual(entriesResponse.entries?.count, 1)
        XCTAssertEqual(fakeStorage.getEntriesHistory.first ?? "unexpected", "com.example.settings")
    }

    func testGetPreferencesStandardMapsToNil() {
        let request = WebSocketRequest.getPreferences(RequestGetPreferences(
            requestId: "get-std",
            fileName: "Standard"
        ))
        _ = commandHandler.handle(request)
        XCTAssertEqual(fakeStorage.getEntriesHistory, [nil])
    }

    // MARK: - Get Single Preference

    func testGetPreferenceFound() {
        fakeStorage.setEntries([
            StorageEntry(key: "name", value: "Alice", type: "STRING"),
        ])

        let request = WebSocketRequest.getPreference(RequestGetPreference(
            requestId: "get-1",
            key: "name"
        ))
        guard let entryResponse = handleRequest(request, as: StorageEntryResponse.self) else { return }

        XCTAssertTrue(entryResponse.success)
        XCTAssertTrue(entryResponse.found)
        XCTAssertEqual(entryResponse.key, "name")
        XCTAssertEqual(entryResponse.value, "Alice")
        XCTAssertEqual(entryResponse.valueType, "STRING")
    }

    func testGetPreferenceNotFound() {
        let request = WebSocketRequest.getPreference(RequestGetPreference(
            requestId: "get-2",
            key: "nonexistent"
        ))
        guard let entryResponse = handleRequest(request, as: StorageEntryResponse.self) else { return }

        XCTAssertTrue(entryResponse.success)
        XCTAssertFalse(entryResponse.found)
        XCTAssertNil(entryResponse.key)
    }

    func testGetPreferenceMissingKey() {
        let request = WebSocketRequest.getPreference(RequestGetPreference(requestId: "get-3"))
        guard let entryResponse = handleRequest(request, as: StorageEntryResponse.self) else { return }

        XCTAssertFalse(entryResponse.success)
        XCTAssertTrue(entryResponse.error?.contains("key") ?? false)
    }

    // MARK: - Set Preference

    func testSetPreferenceSuccess() {
        let request = WebSocketRequest.setPreference(RequestSetPreference(
            requestId: "set-1",
            key: "theme",
            value: "dark",
            valueType: "STRING"
        ))
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(wsResponse.success ?? false)
        XCTAssertEqual(wsResponse.type, "set_preference_result")
        XCTAssertEqual(fakeStorage.setEntryHistory.count, 1)
        XCTAssertEqual(fakeStorage.setEntryHistory[0].key, "theme")
        XCTAssertEqual(fakeStorage.setEntryHistory[0].value, "dark")
        XCTAssertEqual(fakeStorage.setEntryHistory[0].type, "STRING")
    }

    /// `key` is now decode-required for `set_preference`.
    func testSetPreferenceMissingKeyFailsToDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(
                #"{"type":"set_preference","requestId":"set-2","value":"dark","valueType":"STRING"}"#
            )
        )
    }

    // MARK: - Remove Preference

    func testRemovePreferenceSuccess() {
        let request = WebSocketRequest.removePreference(RequestRemovePreference(
            requestId: "rm-1",
            key: "theme"
        ))
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(wsResponse.success ?? false)
        XCTAssertEqual(wsResponse.type, "remove_preference_result")
        XCTAssertEqual(fakeStorage.removeEntryHistory.count, 1)
        XCTAssertEqual(fakeStorage.removeEntryHistory[0].key, "theme")
    }

    // MARK: - Clear Preferences

    func testClearPreferencesSuccess() {
        let request = WebSocketRequest.clearPreferences(RequestClearPreferences(
            requestId: "clear-1",
            fileName: "com.example.settings"
        ))
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(wsResponse.success ?? false)
        XCTAssertEqual(wsResponse.type, "clear_preferences_result")
        XCTAssertEqual(fakeStorage.clearEntriesHistory.count, 1)
        XCTAssertEqual(fakeStorage.clearEntriesHistory[0], "com.example.settings")
    }

    // MARK: - Nil Inspector

    func testStorageCommandsWhenInspectorNil() {
        let handlerNoStorage = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            storageInspector: nil
        )

        let request = WebSocketRequest.listPreferenceFiles(RequestEnvelope(requestId: "nil-1"))
        guard let filesResponse = handleRequest(handlerNoStorage, request, as: StorageFilesResponse.self)
        else { return }

        XCTAssertFalse(filesResponse.success)
        XCTAssertTrue(filesResponse.error?.contains("not available") ?? false)
    }

    // MARK: - Error Propagation

    func testSetPreferenceErrorPropagation() {
        fakeStorage.setShouldThrow(StorageError.invalidValue("bad", "INT"))

        let request = WebSocketRequest.setPreference(RequestSetPreference(
            requestId: "err-1",
            key: "count",
            value: "bad",
            valueType: "INT"
        ))
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(wsResponse.success ?? true)
        XCTAssertTrue(wsResponse.error?.contains("parse") ?? false)
    }
}

// MARK: - Database Command Tests

final class DatabaseCommandHandlerTests: XCTestCase {
    var fakeTimeProvider: FakeTimeProvider!
    var perfProvider: PerfProvider!
    var fakeElementLocator: FakeElementLocator!
    var fakeGesturePerformer: FakeGesturePerformer!
    var fakeSdkHierarchy: FakeSdkHierarchyFetcher!
    var fakeDatabase: FakeSdkDatabaseFetcher!
    var commandHandler: CommandHandler!

    override func setUp() {
        super.setUp()
        fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        fakeElementLocator = FakeElementLocator()
        fakeGesturePerformer = FakeGesturePerformer()
        fakeSdkHierarchy = FakeSdkHierarchyFetcher()
        fakeSdkHierarchy.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app"))
        fakeDatabase = FakeSdkDatabaseFetcher()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            sdkHierarchyClient: fakeSdkHierarchy,
            sdkDatabaseClient: fakeDatabase
        )
    }

    override func tearDown() {
        perfProvider.clear()
        PerfProvider.resetInstance()
        super.tearDown()
    }

    private func handleRequest<T>(
        _ request: WebSocketRequest,
        as _: T.Type = T.self,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> T?
    {
        let response = commandHandler.handle(request)
        guard let typed = response as? T else {
            XCTFail("Expected \(T.self), got \(Swift.type(of: response))", file: file, line: line)
            return nil
        }
        return typed
    }

    func testExecuteSqlRelaysQueryToSdkDatabaseClient() {
        fakeDatabase.executeSqlResult = SdkExecuteSqlResult(
            queryType: "query",
            columns: ["id", "payload"],
            rows: [["1", "0xCAFE"]],
            rowsAffected: 0
        )

        let request = WebSocketRequest.executeSql(RequestExecuteSql(
            requestId: "sql-1",
            appId: "com.example.app",
            databasePath: "/app/Documents/app.db",
            query: "SELECT id, payload FROM notes"
        ))

        guard let response = handleRequest(request, as: ExecuteSqlResponse.self) else { return }

        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "execute_sql_result")
        XCTAssertEqual(response.requestId, "sql-1")
        XCTAssertEqual(response.queryType, "query")
        XCTAssertEqual(response.columns, ["id", "payload"])
        XCTAssertEqual(response.rows, [["1", "0xCAFE"]])
        XCTAssertEqual(fakeDatabase.executeSqlCalls.count, 1)
        XCTAssertEqual(fakeDatabase.executeSqlCalls[0].databasePath, "/app/Documents/app.db")
        XCTAssertEqual(fakeDatabase.executeSqlCalls[0].query, "SELECT id, payload FROM notes")
    }

    func testExecuteSqlReturnsActionableErrorWhenSdkDatabaseUnavailable() {
        fakeDatabase.executeSqlError = SdkDatabaseError
            .unavailable(
                "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"
            )

        let request = WebSocketRequest.executeSql(RequestExecuteSql(
            requestId: "sql-disabled",
            appId: "com.example.app",
            databasePath: "/app/Documents/app.db",
            query: "SELECT 1"
        ))

        guard let response = handleRequest(request, as: ExecuteSqlResponse.self) else { return }

        XCTAssertFalse(response.success)
        XCTAssertTrue(response.error?.contains("setEnabled(true)") ?? false)
    }

    func testExecuteSqlRejectsSdkServerBundleMismatchBeforeDatabaseCall() {
        fakeSdkHierarchy.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.other.app"))

        let request = WebSocketRequest.executeSql(RequestExecuteSql(
            requestId: "sql-mismatch",
            appId: "com.example.app",
            databasePath: "/app/Documents/app.db",
            query: "SELECT 1"
        ))

        guard let response = handleRequest(request, as: ExecuteSqlResponse.self) else { return }

        XCTAssertFalse(response.success)
        XCTAssertTrue(response.error?.contains("does not match requested appId") ?? false)
        XCTAssertEqual(fakeDatabase.executeSqlCalls.count, 0)
    }

    // MARK: - get_table_data offset sanitization (#3616)

    func testSanitizedTableOffsetNormalValues() {
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(nil), 0)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(0), 0)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(42), 42)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(42.9), 42) // truncates
    }

    func testSanitizedTableOffsetNegativeClampsToZero() {
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(-1), 0)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(-1e18), 0)
    }

    /// These inputs would trap `Int(_:)` in the pre-fix code and crash the runner
    /// (issue #3616): a magnitude beyond Int64, and the non-finite values.
    func testSanitizedTableOffsetOutOfRangeAndNonFiniteDoNotTrap() {
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(1e19), Int.max)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(.infinity), 0)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(-.infinity), 0)
        XCTAssertEqual(CommandHandler.sanitizedTableOffset(.nan), 0)
    }
}
