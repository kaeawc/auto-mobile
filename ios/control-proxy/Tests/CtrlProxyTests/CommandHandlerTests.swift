@testable import CtrlProxy
import XCTest

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
    ) -> T? {
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
                    )
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

        let response = commandHandler.handle(WebSocketRequest(
            type: RequestType.setNetworkMockRules.rawValue,
            requestId: "mock-sync-1",
            networkMockRules: rules
        ))

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

    func testSetNetworkMockRulesReturnsMissingParameterErrorWhenRulesAbsent() {
        let response = commandHandler.handle(WebSocketRequest(
            type: RequestType.setNetworkMockRules.rawValue,
            requestId: "mock-sync-missing"
        ))

        guard let typed = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse, got \(Swift.type(of: response))")
            return
        }
        XCTAssertEqual(typed.type, ResponseType.setNetworkMockRulesResult.rawValue)
        XCTAssertEqual(typed.requestId, "mock-sync-missing")
        XCTAssertEqual(typed.success, false)
        XCTAssertEqual(typed.error, "Missing required parameter: rules")
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
        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-123"
        )

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-456"
        )

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-sdk-match"
        )

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-sdk-mismatch"
        )

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

        let enriched = commandHandler.enrichWithMatchingSdkHierarchy(makeHierarchy(packageName: "com.apple.Preferences"))

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-sdk-fresh"
        )

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-sdk-no-fresh"
        )

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-sdk-replace-cache"
        )

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

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-error"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(errorResponse.success ?? true)
        XCTAssertNotNil(errorResponse.error)
        XCTAssertTrue(errorResponse.error?.contains("Test error") ?? false)
    }

    // MARK: - Tap Tests

    func testTapCoordinatesSuccess() {
        let request = WebSocketRequest(
            type: "request_tap_coordinates",
            requestId: "tap-123",
            x: 100,
            y: 200
        )

        guard let tapResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(tapResponse.success, true)
        XCTAssertEqual(tapResponse.type, "tap_coordinates_result")

        // Verify tap was performed
        let tapHistory = fakeGesturePerformer.getTapHistory()
        XCTAssertEqual(tapHistory.count, 1)
        XCTAssertEqual(tapHistory.first?.x, 100)
        XCTAssertEqual(tapHistory.first?.y, 200)
    }

    func testTapCoordinatesMissingParameters() {
        let request = WebSocketRequest(
            type: "request_tap_coordinates",
            requestId: "tap-error"
            // Missing x, y
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(errorResponse.success ?? true)
        XCTAssertNotNil(errorResponse.error)
        XCTAssertTrue(errorResponse.error?.contains("x and y") ?? false)
    }

    // MARK: - Swipe Tests

    func testSwipeSuccess() {
        let request = WebSocketRequest(
            type: "request_swipe",
            requestId: "swipe-123",
            duration: 300,
            x1: 100,
            y1: 200,
            x2: 100,
            y2: 500
        )

        guard let swipeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(swipeResponse.success, true)

        // Verify swipe was performed
        let swipeHistory = fakeGesturePerformer.getSwipeHistory()
        XCTAssertEqual(swipeHistory.count, 1)
        XCTAssertEqual(swipeHistory.first?.startY, 200)
        XCTAssertEqual(swipeHistory.first?.endY, 500)
    }

    func testMultiFingerSwipeSuccess() {
        let request = WebSocketRequest(
            type: "request_multi_finger_swipe",
            requestId: "test-multi-finger-swipe",
            duration: 450,
            x1: 100,
            y1: 600,
            x2: 100,
            y2: 200,
            offset: 30,
            fingerCount: 3
        )

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

    func testTwoFingerSwipeUsesMultiFingerHandler() {
        let request = WebSocketRequest(
            type: "request_two_finger_swipe",
            requestId: "test-two-finger-swipe",
            duration: 300,
            x1: 10,
            y1: 20,
            x2: 30,
            y2: 40
        )

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
        let request = WebSocketRequest(
            type: "request_multi_finger_swipe",
            requestId: "test-multi-finger-failure",
            x1: 100,
            y1: 600,
            x2: 100,
            y2: 200,
            fingerCount: 3
        )

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(response.success ?? true)
        XCTAssertEqual(response.type, "multi_finger_swipe_result")
        XCTAssertTrue(response.error?.contains("XCTest private multi-touch event synthesis classes are unavailable") ?? false)
    }

    // MARK: - Text Input Tests

    func testSetTextSuccess() {
        let request = WebSocketRequest(
            type: "request_set_text",
            requestId: "text-123",
            text: "Hello World"
        )

        guard let textResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(textResponse.success, true)

        // Verify text was typed
        let textHistory = fakeGesturePerformer.getTypeTextHistory()
        XCTAssertEqual(textHistory.count, 1)
        XCTAssertEqual(textHistory.first, "Hello World")
    }

    func testSetTextWithResourceId() {
        let request = WebSocketRequest(
            type: "request_set_text",
            requestId: "text-456",
            text: "Field Text",
            resourceId: "input_field"
        )

        guard let textResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(textResponse.success, true)

        // Verify setText was called (not typeText)
        let setTextHistory = fakeGesturePerformer.getSetTextHistory()
        XCTAssertEqual(setTextHistory.count, 1)
        XCTAssertEqual(setTextHistory.first?.text, "Field Text")
        XCTAssertEqual(setTextHistory.first?.resourceId, "input_field")
    }

    func testSetTextMissingText() {
        let request = WebSocketRequest(
            type: "request_set_text",
            requestId: "text-err-1"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("text") == true)
    }

    func testSetTextTypeTextFailure() {
        fakeGesturePerformer.setFailure(
            for: "typeText",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "No keyboard focus"])
        )

        let request = WebSocketRequest(
            type: "request_set_text",
            requestId: "text-fail-1",
            text: "Hello"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testSetTextSetTextFailure() {
        fakeGesturePerformer.setFailure(
            for: "setText",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Element not found"])
        )

        let request = WebSocketRequest(
            type: "request_set_text",
            requestId: "text-fail-2",
            text: "Hello",
            resourceId: "missing_field"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testImeActionSuccess() {
        let request = WebSocketRequest(
            type: "request_ime_action",
            requestId: "ime-1",
            action: "done"
        )

        guard let imeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(imeResponse.success, true)
        XCTAssertEqual(imeResponse.type, "ime_action_result")
        XCTAssertEqual(fakeGesturePerformer.getImeActionHistory(), ["done"])
    }

    func testImeActionMissingAction() {
        let request = WebSocketRequest(
            type: "request_ime_action",
            requestId: "ime-err-1"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("action") == true)
    }

    func testImeActionFailure() {
        fakeGesturePerformer.setFailure(
            for: "imeAction",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported"])
        )

        let request = WebSocketRequest(
            type: "request_ime_action",
            requestId: "ime-fail-1",
            action: "previous"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testSelectAllSuccess() {
        let request = WebSocketRequest(
            type: "request_select_all",
            requestId: "sel-1"
        )

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

        let request = WebSocketRequest(
            type: "request_select_all",
            requestId: "sel-fail-1"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testKeyboardDetectSuccess() {
        fakeGesturePerformer.setKeyboardOpen(true)
        let request = WebSocketRequest(
            type: "request_keyboard",
            requestId: "keyboard-detect",
            action: "detect"
        )

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "keyboard_result")
        XCTAssertEqual(response.open, true)
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["detect"])
    }

    func testKeyboardOpenSuccess() {
        let request = WebSocketRequest(
            type: "request_keyboard",
            requestId: "keyboard-open",
            action: "open"
        )

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.open, true)
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["open"])
    }

    func testKeyboardOpenFailureWhenKeyboardRemainsClosed() {
        fakeGesturePerformer.setNextKeyboardResult(false)
        let request = WebSocketRequest(
            type: "request_keyboard",
            requestId: "keyboard-open-failed",
            action: "open"
        )

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.open, false)
        XCTAssertEqual(response.error, "Keyboard did not open")
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["open"])
    }

    func testKeyboardCloseSuccess() {
        fakeGesturePerformer.setKeyboardOpen(true)
        let request = WebSocketRequest(
            type: "request_keyboard",
            requestId: "keyboard-close",
            action: "close"
        )

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.open, false)
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["close"])
    }

    func testKeyboardCloseFailureWhenKeyboardRemainsOpen() {
        fakeGesturePerformer.setNextKeyboardResult(true)
        let request = WebSocketRequest(
            type: "request_keyboard",
            requestId: "keyboard-close-failed",
            action: "close"
        )

        guard let response = handleRequest(request, as: KeyboardResponse.self) else { return }

        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.open, true)
        XCTAssertEqual(response.error, "Keyboard did not close")
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["close"])
    }

    func testKeyboardMissingAction() {
        let request = WebSocketRequest(
            type: "request_keyboard",
            requestId: "keyboard-missing"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
        XCTAssertEqual(errorResponse.type, "keyboard_result")
        XCTAssertTrue(errorResponse.error?.contains("action") == true)
    }

    func testClearTextWithoutResourceId() {
        let request = WebSocketRequest(
            type: "request_clear_text",
            requestId: "clear-1"
        )

        guard let clearResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clearResponse.success, true)
        XCTAssertEqual(clearResponse.type, "clear_text_result")

        let clearHistory = fakeGesturePerformer.getClearTextHistory()
        XCTAssertEqual(clearHistory.count, 1)
        XCTAssertNil(clearHistory[0])
    }

    func testClearTextWithResourceId() {
        let request = WebSocketRequest(
            type: "request_clear_text",
            requestId: "clear-2",
            resourceId: "text_input"
        )

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

        let request = WebSocketRequest(
            type: "request_clear_text",
            requestId: "clear-fail-1"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testClipboardGetSuccess() {
        fakeGesturePerformer.setClipboardContents("Copied text")

        let request = WebSocketRequest(
            type: "request_clipboard",
            requestId: "clip-1",
            action: "get"
        )

        guard let clipResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clipResponse.success, true)
        XCTAssertEqual(clipResponse.type, "clipboard_result")
        XCTAssertEqual(clipResponse.text, "Copied text")
    }

    func testClipboardCopySuccess() {
        let request = WebSocketRequest(
            type: "request_clipboard",
            requestId: "clip-2",
            text: "To copy",
            action: "copy"
        )

        guard let clipResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(clipResponse.success, true)

        let history = fakeGesturePerformer.getClipboardHistory()
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].action, "copy")
        XCTAssertEqual(history[0].text, "To copy")
    }

    func testClipboardMissingAction() {
        let request = WebSocketRequest(
            type: "request_clipboard",
            requestId: "clip-err-1"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("action") == true)
    }

    func testClipboardFailure() {
        fakeGesturePerformer.setFailure(
            for: "clipboard",
            error: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Clipboard error"])
        )

        let request = WebSocketRequest(
            type: "request_clipboard",
            requestId: "clip-fail-1",
            action: "get"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }
        XCTAssertEqual(errorResponse.success, false)
    }

    // MARK: - Device Control Tests

    func testPressHomeSuccess() {
        let request = WebSocketRequest(
            type: "request_press_home",
            requestId: "home-123"
        )

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
        let request = WebSocketRequest(
            type: "request_press_back",
            requestId: "back-123"
        )

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
        let request = WebSocketRequest(
            type: "request_press_button",
            requestId: "button-back",
            action: "back"
        )

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["back"])
        XCTAssertEqual(fakeElementLocator.switchedBundleIds, [])
        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, [])
    }

    func testPressButtonHomeSwitchesToSpringBoard() {
        let request = WebSocketRequest(
            type: "request_press_button",
            requestId: "button-home",
            action: "home"
        )

        guard let response = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["home"])
        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.apple.springboard"])
        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.apple.springboard"])
    }

    func testLaunchAppSuccess() {
        // Default: app not running, no coldBoot → full launch
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-123",
            bundleId: "com.apple.Preferences"
        )

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
        XCTAssertEqual(childNames, ["checkAppState", "launchApp", "switchForegroundApp", "updateApplication", "awaitForeground"])
    }

    func testLaunchAppUsesActivateWhenRunningBackground() {
        fakeElementLocator.getAppStateResult = .runningBackground
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-activate",
            bundleId: "com.example.app"
        )

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
        XCTAssertEqual(childNames, ["checkAppState", "activateApp", "switchForegroundApp", "updateApplication", "awaitForeground"])
    }

    func testLaunchAppUsesActivateWhenRunningForeground() {
        fakeElementLocator.getAppStateResult = .runningForeground
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-fg",
            bundleId: "com.example.app"
        )

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
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-cold",
            bundleId: "com.example.app",
            coldBoot: true
        )

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
        XCTAssertEqual(childNames, ["checkAppState", "terminateApp", "launchApp", "switchForegroundApp", "updateApplication", "awaitForeground"])
    }

    func testLaunchAppColdBootNotRunningSkipsTerminate() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-cold-nr",
            bundleId: "com.example.app",
            coldBoot: true
        )

        _ = commandHandler.handle(request)

        // Not running → no terminate needed, just launch
        XCTAssertEqual(fakeGesturePerformer.getAppTerminateHistory(), [])
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), ["com.example.app"])
    }

    // MARK: - Explicit State Transition Tests

    func testLaunchAppSwitchesForegroundApp() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-switch",
            bundleId: "com.example.app"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.example.app"])
    }

    func testLaunchAppUpdatesGesturePerformer() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-gesture",
            bundleId: "com.example.app"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.example.app"])
    }

    func testLaunchAppAwaitsForegroundState() {
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-await",
            bundleId: "com.example.app"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.awaitStateCalls.count, 1)
        XCTAssertEqual(fakeElementLocator.awaitStateCalls.first?.bundleId, "com.example.app")
        XCTAssertEqual(fakeElementLocator.awaitStateCalls.first?.expectedState, .foreground)
    }

    func testPressHomeSwitchesToSpringboard() {
        let request = WebSocketRequest(
            type: "request_press_home",
            requestId: "home-switch"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.apple.springboard"])
    }

    func testPressHomeUpdatesGesturePerformer() {
        let request = WebSocketRequest(
            type: "request_press_home",
            requestId: "home-gesture"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.apple.springboard"])
    }

    // MARK: - Recent Apps Tests

    func testRecentAppsSuccess() {
        let request = WebSocketRequest(
            type: "request_recent_apps",
            requestId: "recents-123"
        )

        guard let recentsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(recentsResponse.success, true)
        XCTAssertEqual(recentsResponse.type, "recent_apps_result")
        XCTAssertEqual(fakeGesturePerformer.getOpenRecentAppsCallCount(), 1)
    }

    func testRecentAppsSwitchesToSpringboard() {
        let request = WebSocketRequest(
            type: "request_recent_apps",
            requestId: "recents-switch"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeElementLocator.switchedBundleIds, ["com.apple.springboard"])
    }

    func testRecentAppsUpdatesGesturePerformer() {
        let request = WebSocketRequest(
            type: "request_recent_apps",
            requestId: "recents-gesture"
        )

        _ = commandHandler.handle(request)

        XCTAssertEqual(fakeGesturePerformer.updateApplicationHistory, ["com.apple.springboard"])
    }

    // MARK: - Shake Tests

    func testShakeSuccess() {
        let request = WebSocketRequest(
            type: "request_shake",
            requestId: "shake-123"
        )

        guard let shakeResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(shakeResponse.success, true)
        XCTAssertEqual(shakeResponse.type, "shake_result")
        XCTAssertEqual(fakeGesturePerformer.getShakeCallCount(), 1)
    }

    // MARK: - Rotate Tests

    func testRotateToLandscapeSuccess() {
        let request = WebSocketRequest(
            type: "request_rotate",
            requestId: "rotate-123",
            orientation: "landscape"
        )

        guard let rotateResponse = handleRequest(request, as: RotateResponse.self) else { return }

        XCTAssertTrue(rotateResponse.success)
        XCTAssertEqual(rotateResponse.type, "rotate_result")
        XCTAssertEqual(rotateResponse.previousOrientation, "portrait")
        XCTAssertEqual(rotateResponse.currentOrientation, "landscape")
        XCTAssertEqual(rotateResponse.value, 1)
        XCTAssertTrue(rotateResponse.rotationPerformed)
    }

    func testRotateToPortraitWhenAlreadyPortrait() {
        let request = WebSocketRequest(
            type: "request_rotate",
            requestId: "rotate-noop",
            orientation: "portrait"
        )

        guard let rotateResponse = handleRequest(request, as: RotateResponse.self) else { return }

        XCTAssertTrue(rotateResponse.success)
        XCTAssertEqual(rotateResponse.previousOrientation, "portrait")
        XCTAssertEqual(rotateResponse.currentOrientation, "portrait")
        XCTAssertEqual(rotateResponse.value, 0)
        XCTAssertFalse(rotateResponse.rotationPerformed)
    }

    func testRotateMissingOrientation() {
        let request = WebSocketRequest(
            type: "request_rotate",
            requestId: "rotate-missing"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertEqual(errorResponse.type, "rotate_result")
        XCTAssertNotNil(errorResponse.error)
        XCTAssertTrue(errorResponse.error?.contains("orientation") == true)
    }

    // MARK: - ObjCExceptionError Propagation Tests

    func testTapWithObjCExceptionReturnsErrorResponse() {
        fakeGesturePerformer.setFailure(
            for: "tap",
            error: ObjCExceptionError(name: "NSRangeException", reason: "index 5 beyond bounds [0..3]")
        )

        let request = WebSocketRequest(
            type: "request_tap_coordinates",
            requestId: "tap-objc-err",
            x: 100,
            y: 200
        )

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

        let request = WebSocketRequest(
            type: "request_swipe",
            requestId: "swipe-objc-err",
            duration: 300,
            x1: 100,
            y1: 200,
            x2: 100,
            y2: 500
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("NSInternalInconsistencyException") ?? false)
        XCTAssertTrue(errorResponse.error?.contains("Invalid snapshot") ?? false)
    }

    func testHierarchyWithObjCExceptionReturnsErrorResponse() {
        fakeElementLocator.setShouldThrow(
            ObjCExceptionError(name: "NSGenericException", reason: "Stale element reference")
        )

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "hier-objc-err"
        )

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

        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-objc-err",
            bundleId: "com.missing.app"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertTrue(errorResponse.error?.contains("NSInvalidArgumentException") ?? false)
        XCTAssertTrue(errorResponse.error?.contains("App not installed") ?? false)
    }

    // MARK: - Unknown Command Tests

    func testUnknownCommand() {
        let request = WebSocketRequest(
            type: "unknown_command",
            requestId: "unknown-123"
        )

        guard let errorResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(errorResponse.success ?? true)
        XCTAssertTrue(errorResponse.error?.contains("Unknown command") ?? false)
    }

    // MARK: - VoiceOver State Tests

    func testGetVoiceOverStateReturnsResponse() {
        let request = WebSocketRequest(
            type: "get_voiceover_state",
            requestId: "voiceover-123"
        )

        guard let voResponse = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        XCTAssertEqual(voResponse.requestId, "voiceover-123")
        XCTAssertEqual(voResponse.type, "voiceover_state_result")
        XCTAssertTrue(voResponse.success)
        // enabled is false in SPM tests (macOS, no UIAccessibility)
        XCTAssertFalse(voResponse.enabled)
        XCTAssertNotNil(voResponse.totalTimeMs)
    }

    func testGetVoiceOverStateWithNilRequestId() {
        let request = WebSocketRequest(
            type: "get_voiceover_state"
        )

        guard let voResponse = handleRequest(request, as: VoiceOverStateResponse.self) else { return }

        XCTAssertNil(voResponse.requestId)
        XCTAssertEqual(voResponse.type, "voiceover_state_result")
        XCTAssertTrue(voResponse.success)
    }

    func testGetVoiceOverStateIsEncodable() throws {
        let request = WebSocketRequest(
            type: "get_voiceover_state",
            requestId: "encode-test"
        )

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
    ) -> T? {
        handleRequest(commandHandler, request, as: T.self, file: file, line: line)
    }

    private func handleRequest<T>(
        _ handler: CommandHandler,
        _ request: WebSocketRequest,
        as _: T.Type = T.self,
        file: StaticString = #file,
        line: UInt = #line
    ) -> T? {
        let response = handler.handle(request)
        guard let typed = response as? T else {
            XCTFail("Expected \(T.self), got \(Swift.type(of: response))", file: file, line: line)
            return nil
        }
        return typed
    }

    // MARK: - List Preference Files

    func testListPreferenceFilesReturnsSuites() throws {
        fakeStorage.setSuites([
            StorageSuiteInfo(name: "Standard", displayName: "Standard", entryCount: 5),
            StorageSuiteInfo(name: "group.com.example", displayName: "group.com.example", entryCount: 3),
        ])

        let request = WebSocketRequest(type: "list_preference_files", requestId: "list-1")
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

        let request = WebSocketRequest(type: "get_preferences", requestId: "get-all-1")
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

        let request = WebSocketRequest(
            type: "get_preferences",
            requestId: "get-all-2",
            fileName: "com.example.settings"
        )
        guard let entriesResponse = handleRequest(request, as: StorageEntriesResponse.self) else { return }

        XCTAssertTrue(entriesResponse.success)
        XCTAssertEqual(entriesResponse.entries?.count, 1)
        XCTAssertEqual(fakeStorage.getEntriesHistory.first ?? "unexpected", "com.example.settings")
    }

    func testGetPreferencesStandardMapsToNil() {
        let request = WebSocketRequest(
            type: "get_preferences",
            requestId: "get-std",
            fileName: "Standard"
        )
        let _ = commandHandler.handle(request)
        XCTAssertEqual(fakeStorage.getEntriesHistory, [nil])
    }

    // MARK: - Get Single Preference

    func testGetPreferenceFound() {
        fakeStorage.setEntries([
            StorageEntry(key: "name", value: "Alice", type: "STRING"),
        ])

        let request = WebSocketRequest(
            type: "get_preference",
            requestId: "get-1",
            key: "name"
        )
        guard let entryResponse = handleRequest(request, as: StorageEntryResponse.self) else { return }

        XCTAssertTrue(entryResponse.success)
        XCTAssertTrue(entryResponse.found)
        XCTAssertEqual(entryResponse.key, "name")
        XCTAssertEqual(entryResponse.value, "Alice")
        XCTAssertEqual(entryResponse.valueType, "STRING")
    }

    func testGetPreferenceNotFound() {
        let request = WebSocketRequest(
            type: "get_preference",
            requestId: "get-2",
            key: "nonexistent"
        )
        guard let entryResponse = handleRequest(request, as: StorageEntryResponse.self) else { return }

        XCTAssertTrue(entryResponse.success)
        XCTAssertFalse(entryResponse.found)
        XCTAssertNil(entryResponse.key)
    }

    func testGetPreferenceMissingKey() {
        let request = WebSocketRequest(
            type: "get_preference",
            requestId: "get-3"
        )
        guard let entryResponse = handleRequest(request, as: StorageEntryResponse.self) else { return }

        XCTAssertFalse(entryResponse.success)
        XCTAssertTrue(entryResponse.error?.contains("key") ?? false)
    }

    // MARK: - Set Preference

    func testSetPreferenceSuccess() {
        let request = WebSocketRequest(
            type: "set_preference",
            requestId: "set-1",
            key: "theme",
            value: "dark",
            valueType: "STRING"
        )
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(wsResponse.success ?? false)
        XCTAssertEqual(wsResponse.type, "set_preference_result")
        XCTAssertEqual(fakeStorage.setEntryHistory.count, 1)
        XCTAssertEqual(fakeStorage.setEntryHistory[0].key, "theme")
        XCTAssertEqual(fakeStorage.setEntryHistory[0].value, "dark")
        XCTAssertEqual(fakeStorage.setEntryHistory[0].type, "STRING")
    }

    func testSetPreferenceMissingKey() {
        let request = WebSocketRequest(
            type: "set_preference",
            requestId: "set-2",
            value: "dark",
            valueType: "STRING"
        )
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(wsResponse.success ?? true)
        XCTAssertTrue(wsResponse.error?.contains("key") ?? false)
    }

    // MARK: - Remove Preference

    func testRemovePreferenceSuccess() {
        let request = WebSocketRequest(
            type: "remove_preference",
            requestId: "rm-1",
            key: "theme"
        )
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertTrue(wsResponse.success ?? false)
        XCTAssertEqual(wsResponse.type, "remove_preference_result")
        XCTAssertEqual(fakeStorage.removeEntryHistory.count, 1)
        XCTAssertEqual(fakeStorage.removeEntryHistory[0].key, "theme")
    }

    // MARK: - Clear Preferences

    func testClearPreferencesSuccess() {
        let request = WebSocketRequest(
            type: "clear_preferences",
            requestId: "clear-1",
            fileName: "com.example.settings"
        )
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

        let request = WebSocketRequest(type: "list_preference_files", requestId: "nil-1")
        guard let filesResponse = handleRequest(handlerNoStorage, request, as: StorageFilesResponse.self) else { return }

        XCTAssertFalse(filesResponse.success)
        XCTAssertTrue(filesResponse.error?.contains("not available") ?? false)
    }

    // MARK: - Error Propagation

    func testSetPreferenceErrorPropagation() {
        fakeStorage.setShouldThrow(StorageError.invalidValue("bad", "INT"))

        let request = WebSocketRequest(
            type: "set_preference",
            requestId: "err-1",
            key: "count",
            value: "bad",
            valueType: "INT"
        )
        guard let wsResponse = handleRequest(request, as: WebSocketResponse.self) else { return }

        XCTAssertFalse(wsResponse.success ?? true)
        XCTAssertTrue(wsResponse.error?.contains("parse") ?? false)
    }
}
