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

        // Handle request
        let response = commandHandler.handle(request)

        // Verify response includes perf timing
        guard let hierarchyResponse = response as? HierarchyUpdateResponse else {
            XCTFail("Expected HierarchyUpdateResponse, got \(type(of: response))")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let hierarchyResponse = response as? HierarchyUpdateResponse else {
            XCTFail("Expected HierarchyUpdateResponse")
            return
        }

        // Verify perf timing structure includes extraction child
        let perfTiming = hierarchyResponse.perfTiming
        XCTAssertNotNil(perfTiming)
        XCTAssertEqual(perfTiming?.name, "handleRequestHierarchy")

        // Should have extraction as a child
        let extractionChild = perfTiming?.children?.first { $0.name == "extraction" }
        XCTAssertNotNil(extractionChild, "Expected 'extraction' child in perf timing")
    }

    func testRequestHierarchyError() {
        // Configure fake to throw error
        fakeElementLocator.setShouldThrow(CommandError.executionFailed("Test error"))

        let request = WebSocketRequest(
            type: "request_hierarchy",
            requestId: "test-error"
        )

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse error")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let tapResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let swipeResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

        XCTAssertEqual(swipeResponse.success, true)

        // Verify swipe was performed
        let swipeHistory = fakeGesturePerformer.getSwipeHistory()
        XCTAssertEqual(swipeHistory.count, 1)
        XCTAssertEqual(swipeHistory.first?.startY, 200)
        XCTAssertEqual(swipeHistory.first?.endY, 500)
    }

    // MARK: - Text Input Tests

    func testSetTextSuccess() {
        let request = WebSocketRequest(
            type: "request_set_text",
            requestId: "text-123",
            text: "Hello World"
        )

        let response = commandHandler.handle(request)

        guard let textResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let textResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testImeActionSuccess() {
        let request = WebSocketRequest(
            type: "request_ime_action",
            requestId: "ime-1",
            action: "done"
        )

        let response = commandHandler.handle(request)

        guard let imeResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
        XCTAssertEqual(imeResponse.success, true)
        XCTAssertEqual(imeResponse.type, "ime_action_result")
        XCTAssertEqual(fakeGesturePerformer.getImeActionHistory(), ["done"])
    }

    func testImeActionMissingAction() {
        let request = WebSocketRequest(
            type: "request_ime_action",
            requestId: "ime-err-1"
        )

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testSelectAllSuccess() {
        let request = WebSocketRequest(
            type: "request_select_all",
            requestId: "sel-1"
        )

        let response = commandHandler.handle(request)

        guard let selResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testClearTextWithoutResourceId() {
        let request = WebSocketRequest(
            type: "request_clear_text",
            requestId: "clear-1"
        )

        let response = commandHandler.handle(request)

        guard let clearResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let clearResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
        XCTAssertEqual(errorResponse.success, false)
    }

    func testClipboardGetSuccess() {
        fakeGesturePerformer.setClipboardContents("Copied text")

        let request = WebSocketRequest(
            type: "request_clipboard",
            requestId: "clip-1",
            action: "get"
        )

        let response = commandHandler.handle(request)

        guard let clipResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let clipResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }
        XCTAssertEqual(errorResponse.success, false)
    }

    // MARK: - Device Control Tests

    func testPressHomeSuccess() {
        let request = WebSocketRequest(
            type: "request_press_home",
            requestId: "home-123"
        )

        let response = commandHandler.handle(request)

        guard let homeResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

    func testLaunchAppSuccess() {
        // Default: app not running, no coldBoot → full launch
        fakeElementLocator.getAppStateResult = .notRunning
        let request = WebSocketRequest(
            type: "request_launch_app",
            requestId: "launch-123",
            bundleId: "com.apple.Preferences"
        )

        let response = commandHandler.handle(request)

        guard let launchResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let launchResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let recentsResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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

    // MARK: - Rotate Tests

    func testRotateToLandscapeSuccess() {
        let request = WebSocketRequest(
            type: "request_rotate",
            requestId: "rotate-123",
            orientation: "landscape"
        )

        let response = commandHandler.handle(request)

        guard let rotateResponse = response as? RotateResponse else {
            XCTFail("Expected RotateResponse, got \(type(of: response))")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let rotateResponse = response as? RotateResponse else {
            XCTFail("Expected RotateResponse, got \(type(of: response))")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

        XCTAssertEqual(errorResponse.success, false)
        XCTAssertEqual(errorResponse.type, "rotate_result")
        XCTAssertNotNil(errorResponse.error)
        XCTAssertTrue(errorResponse.error?.contains("orientation") == true)
    }

    // MARK: - Unknown Command Tests

    func testUnknownCommand() {
        let request = WebSocketRequest(
            type: "unknown_command",
            requestId: "unknown-123"
        )

        let response = commandHandler.handle(request)

        guard let errorResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

        XCTAssertFalse(errorResponse.success ?? true)
        XCTAssertTrue(errorResponse.error?.contains("Unknown command") ?? false)
    }

    // MARK: - VoiceOver State Tests

    func testGetVoiceOverStateReturnsResponse() {
        let request = WebSocketRequest(
            type: "get_voiceover_state",
            requestId: "voiceover-123"
        )

        let response = commandHandler.handle(request)

        guard let voResponse = response as? VoiceOverStateResponse else {
            XCTFail("Expected VoiceOverStateResponse, got \(type(of: response))")
            return
        }

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

        let response = commandHandler.handle(request)

        guard let voResponse = response as? VoiceOverStateResponse else {
            XCTFail("Expected VoiceOverStateResponse")
            return
        }

        XCTAssertNil(voResponse.requestId)
        XCTAssertEqual(voResponse.type, "voiceover_state_result")
        XCTAssertTrue(voResponse.success)
    }

    func testGetVoiceOverStateIsEncodable() throws {
        let request = WebSocketRequest(
            type: "get_voiceover_state",
            requestId: "encode-test"
        )

        let response = commandHandler.handle(request)

        guard let voResponse = response as? VoiceOverStateResponse else {
            XCTFail("Expected VoiceOverStateResponse")
            return
        }

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

    // MARK: - List Preference Files

    func testListPreferenceFilesReturnsSuites() throws {
        fakeStorage.setSuites([
            StorageSuiteInfo(name: "Standard", displayName: "Standard", entryCount: 5),
            StorageSuiteInfo(name: "group.com.example", displayName: "group.com.example", entryCount: 3),
        ])

        let request = WebSocketRequest(type: "list_preference_files", requestId: "list-1")
        let response = commandHandler.handle(request)

        guard let filesResponse = response as? StorageFilesResponse else {
            XCTFail("Expected StorageFilesResponse, got \(type(of: response))")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let entriesResponse = response as? StorageEntriesResponse else {
            XCTFail("Expected StorageEntriesResponse, got \(type(of: response))")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let entriesResponse = response as? StorageEntriesResponse else {
            XCTFail("Expected StorageEntriesResponse")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let entryResponse = response as? StorageEntryResponse else {
            XCTFail("Expected StorageEntryResponse, got \(type(of: response))")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let entryResponse = response as? StorageEntryResponse else {
            XCTFail("Expected StorageEntryResponse")
            return
        }

        XCTAssertTrue(entryResponse.success)
        XCTAssertFalse(entryResponse.found)
        XCTAssertNil(entryResponse.key)
    }

    func testGetPreferenceMissingKey() {
        let request = WebSocketRequest(
            type: "get_preference",
            requestId: "get-3"
        )
        let response = commandHandler.handle(request)

        guard let entryResponse = response as? StorageEntryResponse else {
            XCTFail("Expected StorageEntryResponse")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let wsResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse, got \(type(of: response))")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let wsResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let wsResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let wsResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

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
        let response = handlerNoStorage.handle(request)

        guard let filesResponse = response as? StorageFilesResponse else {
            XCTFail("Expected StorageFilesResponse, got \(type(of: response))")
            return
        }

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
        let response = commandHandler.handle(request)

        guard let wsResponse = response as? WebSocketResponse else {
            XCTFail("Expected WebSocketResponse")
            return
        }

        XCTAssertFalse(wsResponse.success ?? true)
        XCTAssertTrue(wsResponse.error?.contains("parse") ?? false)
    }
}
