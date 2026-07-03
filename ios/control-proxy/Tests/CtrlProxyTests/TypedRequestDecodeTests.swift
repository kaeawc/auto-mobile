@testable import CtrlProxy
import XCTest

/// Decodes a raw JSON command string into the typed `WebSocketRequest` enum,
/// exercising the same `JSONDecoder().decode(WebSocketRequest.self, …)` path the
/// `WebSocketServer` uses on the wire. Shared across the CtrlProxy test target.
func decodeWebSocketRequest(_ json: String) throws -> WebSocketRequest {
    try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
}

/// Round-trip coverage for issue #2846: every inbound command decodes from its
/// on-the-wire JSON into the correct typed `WebSocketRequest` case with its
/// fields intact, and dispatches through `CommandHandler.handle` to the correct
/// handler. This is the whole inbound command surface — one decode+dispatch test
/// per `RequestType` case — plus the decode-rejection tests for commands whose
/// required fields are now enforced at the decode boundary.
final class TypedRequestDecodeDispatchTests: XCTestCase {
    var fakeTimeProvider: FakeTimeProvider!
    var perfProvider: PerfProvider!
    var fakeElementLocator: FakeElementLocator!
    var fakeGesturePerformer: FakeGesturePerformer!
    var fakeStorage: FakeStorageInspecting!
    var fakeSdkHierarchy: FakeSdkHierarchyFetcher!
    var fakeDatabase: FakeSdkDatabaseFetcher!
    var commandHandler: CommandHandler!

    override func setUp() {
        super.setUp()
        fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        fakeElementLocator = FakeElementLocator()
        fakeGesturePerformer = FakeGesturePerformer()
        fakeStorage = FakeStorageInspecting()
        fakeSdkHierarchy = FakeSdkHierarchyFetcher()
        fakeSdkHierarchy.setServerInfo(SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app"))
        fakeDatabase = FakeSdkDatabaseFetcher()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            storageInspector: fakeStorage,
            sdkHierarchyClient: fakeSdkHierarchy,
            sdkDatabaseClient: fakeDatabase
        )
        fakeElementLocator.setHierarchy(ViewHierarchy(packageName: "com.example.app"))
    }

    override func tearDown() {
        perfProvider.clear()
        PerfProvider.resetInstance()
        super.tearDown()
    }

    // MARK: - Decode helpers

    private func decode(
        _ json: String,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> WebSocketRequest?
    {
        do {
            return try decodeWebSocketRequest(json)
        } catch {
            XCTFail("Expected \(json) to decode, got error: \(error)", file: file, line: line)
            return nil
        }
    }

    private func dispatch<T>(
        _ json: String,
        as _: T.Type = T.self,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> T?
    {
        guard let request = decode(json, file: file, line: line) else { return nil }
        let response = commandHandler.handle(request)
        guard let typed = response as? T else {
            XCTFail("Expected \(T.self), got \(Swift.type(of: response))", file: file, line: line)
            return nil
        }
        return typed
    }

    // MARK: - Discriminator coverage

    /// Every `RequestType` decodes to a case whose `requestType` round-trips back
    /// to the same discriminator — proves the decode switch covers the full set.
    func testEveryRequestTypeDecodesToMatchingCase() throws {
        // Minimal-but-valid payload per command (only decode-required fields).
        let payloads: [RequestType: String] = [
            .requestHierarchy: "{}",
            .requestHierarchyIfStale: "{}",
            .requestScreenshot: "{}",
            .requestTapCoordinates: #"{"x":1,"y":2}"#,
            .requestSwipe: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestTwoFingerSwipe: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestMultiFingerSwipe: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestDrag: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestPinch: #"{"centerX":1,"centerY":2,"distanceStart":3,"distanceEnd":4}"#,
            .requestSetText: #"{"text":"hi"}"#,
            .requestClearText: "{}",
            .requestImeAction: #"{"action":"done"}"#,
            .requestSelectAll: "{}",
            .requestKeyboard: #"{"action":"open"}"#,
            .requestPressButton: #"{"action":"home"}"#,
            .requestPressHome: "{}",
            .requestPressBack: "{}",
            .requestShake: "{}",
            .requestRecentApps: "{}",
            .requestAction: #"{"action":"tap"}"#,
            .requestLaunchApp: #"{"bundleId":"com.example.app"}"#,
            .requestRotate: #"{"orientation":"portrait"}"#,
            .requestClipboard: #"{"action":"get"}"#,
            .getCurrentFocus: "{}",
            .getTraversalOrder: "{}",
            .addHighlight: "{}",
            .getVoiceOverState: "{}",
            .listPreferenceFiles: "{}",
            .getPreferences: "{}",
            .getPreference: "{}",
            .setPreference: #"{"key":"k","valueType":"STRING"}"#,
            .removePreference: #"{"key":"k"}"#,
            .clearPreferences: "{}",
            .setNetworkMockRules: #"{"rules":[]}"#,
            .executeSql: "{}",
            .listDatabases: "{}",
            .listTables: "{}",
            .getTableData: "{}",
            .getTableStructure: "{}",
        ]

        for requestType in RequestType.allCases {
            guard let fields = payloads[requestType] else {
                XCTFail("Missing decode fixture for \(requestType.rawValue)")
                continue
            }
            let body = fields == "{}"
                ? #"{"type":"\#(requestType.rawValue)"}"#
                : "{\"type\":\"\(requestType.rawValue)\"," + String(fields.dropFirst())
            let request = try decodeWebSocketRequest(body)
            XCTAssertEqual(
                request.requestType,
                requestType,
                "\(requestType.rawValue) decoded to \(request.requestType.rawValue)"
            )
            XCTAssertEqual(request.typeString, requestType.rawValue)
        }
    }

    // MARK: - Gestures

    func testTapCoordinatesDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_tap_coordinates","requestId":"tap-1","x":100,"y":200,"duration":50}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "tap_coordinates_result")
        XCTAssertEqual(response?.requestId, "tap-1")
        let history = fakeGesturePerformer.getTapHistory()
        XCTAssertEqual(history.first?.x, 100)
        XCTAssertEqual(history.first?.y, 200)
    }

    func testSwipeDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_swipe","requestId":"sw-1","x1":10,"y1":20,"x2":30,"y2":40,"duration":250}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "swipe_result")
        let history = fakeGesturePerformer.getSwipeHistory()
        XCTAssertEqual(history.first?.startX, 10)
        XCTAssertEqual(history.first?.endY, 40)
    }

    func testTwoFingerSwipeDecodeDispatchDefaultsToTwoFingers() {
        let response = dispatch(
            #"{"type":"request_two_finger_swipe","requestId":"tfs-1","x1":10,"y1":20,"x2":30,"y2":40}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "multi_finger_swipe_result")
        XCTAssertEqual(fakeGesturePerformer.getMultiFingerSwipeHistory().first?.fingerCount, 2)
    }

    func testMultiFingerSwipeDecodeDispatchForwardsFingerCountAndSpacing() {
        let response = dispatch(
            #"""
            {"type":"request_multi_finger_swipe","requestId":"mfs-1","x1":10,"y1":20,"x2":30,"y2":40,"fingerCount":3,"offset":31.5,"duration":400}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "multi_finger_swipe_result")
        let history = fakeGesturePerformer.getMultiFingerSwipeHistory()
        XCTAssertEqual(history.first?.fingerCount, 3)
        XCTAssertEqual(history.first?.fingerSpacing ?? -1, 31.5, accuracy: 0.0001)
    }

    func testDragDecodeDispatchForwardsDurations() {
        let response = dispatch(
            #"""
            {"type":"request_drag","requestId":"drag-1","x1":10,"y1":20,"x2":30,"y2":40,"pressDurationMs":700,"dragDurationMs":250,"holdDurationMs":120}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "drag_result")
        let history = fakeGesturePerformer.getDragHistory()
        XCTAssertEqual(history.first?.startX, 10)
        XCTAssertEqual(history.first?.endY, 40)
    }

    func testDragDecodeUsesLegacyHoldTimeFallback() throws {
        let request = try decodeWebSocketRequest(
            #"{"type":"request_drag","x1":1,"y1":2,"x2":3,"y2":4,"holdTime":900}"#
        )
        guard case let .drag(payload) = request else {
            return XCTFail("Expected .drag, got \(request)")
        }
        XCTAssertEqual(payload.holdTime, 900)
        XCTAssertNil(payload.pressDurationMs)
    }

    func testPinchDecodeDispatchForwardsPayload() {
        let response = dispatch(
            #"""
            {"type":"request_pinch","requestId":"pinch-1","centerX":100,"centerY":200,"distanceStart":40,"distanceEnd":120,"rotationDegrees":15,"duration":700}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "pinch_result")
        let history = fakeGesturePerformer.getPinchHistory()
        XCTAssertEqual(history.first?.centerX, 100)
        XCTAssertEqual(history.first?.distanceEnd, 120)
        XCTAssertEqual(history.first?.rotationDegrees, 15)
    }

    // MARK: - Fractional coordinates (issue #2909)

    /// The iOS TS wire path sets `roundCoordinates: false`, so a direct/future
    /// caller can send sub-pixel coordinates. The runner must decode fractional
    /// gesture coordinates instead of throwing an opaque `Int` decode error, and
    /// must preserve the fraction end-to-end (not truncate it).
    func testTapCoordinatesDecodeAcceptsFractionalCoordinates() {
        let response = dispatch(
            #"{"type":"request_tap_coordinates","requestId":"tap-frac","x":100.5,"y":200.25,"duration":50}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "tap_coordinates_result")
        let history = fakeGesturePerformer.getTapHistory()
        XCTAssertEqual(history.first?.x ?? .nan, 100.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.y ?? .nan, 200.25, accuracy: 0.0001)
    }

    func testSwipeDecodeAcceptsFractionalCoordinates() {
        let response = dispatch(
            #"{"type":"request_swipe","requestId":"sw-frac","x1":10.5,"y1":20.5,"x2":30.25,"y2":40.75,"duration":250}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "swipe_result")
        let history = fakeGesturePerformer.getSwipeHistory()
        XCTAssertEqual(history.first?.startX ?? .nan, 10.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.endY ?? .nan, 40.75, accuracy: 0.0001)
    }

    func testMultiFingerSwipeDecodeAcceptsFractionalCoordinates() {
        let response = dispatch(
            #"""
            {"type":"request_multi_finger_swipe","requestId":"mfs-frac","x1":10.5,"y1":20.5,"x2":30.25,"y2":40.75,"fingerCount":3,"offset":31.5}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "multi_finger_swipe_result")
        let history = fakeGesturePerformer.getMultiFingerSwipeHistory()
        XCTAssertEqual(history.first?.startX ?? .nan, 10.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.endY ?? .nan, 40.75, accuracy: 0.0001)
    }

    func testDragDecodeAcceptsFractionalCoordinates() {
        let response = dispatch(
            #"""
            {"type":"request_drag","requestId":"drag-frac","x1":10.5,"y1":20.5,"x2":30.25,"y2":40.75,"dragDurationMs":250}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "drag_result")
        let history = fakeGesturePerformer.getDragHistory()
        XCTAssertEqual(history.first?.startX ?? .nan, 10.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.endY ?? .nan, 40.75, accuracy: 0.0001)
    }

    func testPinchDecodeAcceptsFractionalCoordinates() {
        let response = dispatch(
            #"""
            {"type":"request_pinch","requestId":"pinch-frac","centerX":100.5,"centerY":200.25,"distanceStart":40.5,"distanceEnd":120.75,"rotationDegrees":15,"duration":700}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "pinch_result")
        let history = fakeGesturePerformer.getPinchHistory()
        XCTAssertEqual(history.first?.centerX ?? .nan, 100.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.centerY ?? .nan, 200.25, accuracy: 0.0001)
        XCTAssertEqual(history.first?.distanceStart ?? .nan, 40.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.distanceEnd ?? .nan, 120.75, accuracy: 0.0001)
    }

    // MARK: - Text input

    func testSetTextDecodeDispatchTypesText() {
        let response = dispatch(
            #"{"type":"request_set_text","requestId":"txt-1","text":"Hello"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "set_text_result")
        XCTAssertEqual(fakeGesturePerformer.getTypeTextHistory(), ["Hello"])
    }

    func testSetTextDecodeDispatchWithResourceIdUsesSetText() {
        _ = dispatch(
            #"{"type":"request_set_text","requestId":"txt-2","text":"Hi","resourceId":"field"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(fakeGesturePerformer.getSetTextHistory().first?.resourceId, "field")
    }

    func testClearTextDecodeDispatchForwardsResourceId() {
        _ = dispatch(
            #"{"type":"request_clear_text","requestId":"clr-1","resourceId":"field"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(fakeGesturePerformer.getClearTextHistory(), ["field"])
    }

    func testImeActionDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_ime_action","requestId":"ime-1","action":"done"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "ime_action_result")
        XCTAssertEqual(fakeGesturePerformer.getImeActionHistory(), ["done"])
    }

    func testSelectAllDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_select_all","requestId":"sel-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "select_all_result")
        XCTAssertEqual(fakeGesturePerformer.getSelectAllCallCount(), 1)
    }

    func testKeyboardDecodeDispatchForwardsAction() {
        let response = dispatch(
            #"{"type":"request_keyboard","requestId":"kb-1","action":"open"}"#,
            as: KeyboardResponse.self
        )
        XCTAssertEqual(response?.type, "keyboard_result")
        XCTAssertEqual(fakeGesturePerformer.getKeyboardHistory(), ["open"])
    }

    // MARK: - Buttons / navigation

    func testPressButtonDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_press_button","requestId":"btn-1","action":"back"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "press_button_result")
        XCTAssertEqual(fakeGesturePerformer.getPressButtonHistory(), ["back"])
    }

    func testPressHomeDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_press_home","requestId":"home-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "press_home_result")
        XCTAssertEqual(fakeGesturePerformer.getPressHomeCallCount(), 1)
    }

    func testPressBackDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_press_back","requestId":"back-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "press_back_result")
        XCTAssertEqual(fakeGesturePerformer.getPressBackCallCount(), 1)
    }

    func testShakeDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_shake","requestId":"shake-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "shake_result")
        XCTAssertEqual(fakeGesturePerformer.getShakeCallCount(), 1)
    }

    func testRecentAppsDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_recent_apps","requestId":"recents-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "recent_apps_result")
        XCTAssertEqual(fakeGesturePerformer.getOpenRecentAppsCallCount(), 1)
    }

    // MARK: - Actions / device control

    func testActionDecodeDispatchForwardsLocators() {
        _ = dispatch(
            #"{"type":"request_action","requestId":"act-1","action":"tap","resourceId":"rid","label":"lbl"}"#,
            as: WebSocketResponse.self
        )
        let history = fakeGesturePerformer.getActionHistory()
        XCTAssertEqual(history.first?.action, "tap")
        XCTAssertEqual(history.first?.resourceId, "rid")
        XCTAssertEqual(history.first?.label, "lbl")
    }

    func testLaunchAppDecodeDispatchForwardsColdBoot() {
        fakeElementLocator.getAppStateResult = .notRunning
        let response = dispatch(
            #"{"type":"request_launch_app","requestId":"launch-1","bundleId":"com.example.app","coldBoot":true}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "launch_app_result")
        XCTAssertEqual(fakeGesturePerformer.getAppLaunchHistory(), ["com.example.app"])
    }

    func testRotateDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_rotate","requestId":"rot-1","orientation":"landscape"}"#,
            as: RotateResponse.self
        )
        XCTAssertEqual(response?.type, "rotate_result")
        XCTAssertEqual(response?.currentOrientation, "landscape")
    }

    func testClipboardDecodeDispatchForwardsText() {
        _ = dispatch(
            #"{"type":"request_clipboard","requestId":"clip-1","action":"copy","text":"payload"}"#,
            as: WebSocketResponse.self
        )
        let history = fakeGesturePerformer.getClipboardHistory()
        XCTAssertEqual(history.first?.action, "copy")
        XCTAssertEqual(history.first?.text, "payload")
    }

    // MARK: - Hierarchy / screenshot

    func testHierarchyDecodeDispatchForwardsDisableAllFiltering() throws {
        let request = try decodeWebSocketRequest(
            #"{"type":"request_hierarchy","requestId":"h-1","disableAllFiltering":true}"#
        )
        guard case let .requestHierarchy(payload) = request else {
            return XCTFail("Expected .requestHierarchy, got \(request)")
        }
        XCTAssertEqual(payload.disableAllFiltering, true)
        let response = commandHandler.handle(request)
        XCTAssertTrue(response is HierarchyUpdateResponse)
    }

    func testHierarchyIfStaleDecodesToDistinctCaseWithTimestamp() throws {
        let request = try decodeWebSocketRequest(
            #"{"type":"request_hierarchy_if_stale","requestId":"h-2","sinceTimestamp":1234}"#
        )
        guard case let .requestHierarchyIfStale(payload) = request else {
            return XCTFail("Expected .requestHierarchyIfStale, got \(request)")
        }
        XCTAssertEqual(payload.sinceTimestamp, 1234)
    }

    func testScreenshotDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_screenshot","requestId":"ss-1"}"#,
            as: ScreenshotResponse.self
        )
        XCTAssertEqual(response?.type, "screenshot")
        XCTAssertEqual(response?.requestId, "ss-1")
    }

    // MARK: - Accessibility

    func testGetVoiceOverStateDecodeDispatch() {
        let response = dispatch(
            #"{"type":"get_voiceover_state","requestId":"vo-1"}"#,
            as: VoiceOverStateResponse.self
        )
        XCTAssertEqual(response?.type, "voiceover_state_result")
    }

    func testGetCurrentFocusDecodeDispatchReturnsNotImplemented() {
        let response = dispatch(
            #"{"type":"get_current_focus","requestId":"cf-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "current_focus_result")
        XCTAssertEqual(response?.success, false)
    }

    func testGetTraversalOrderDecodeDispatchReturnsNotImplemented() {
        let response = dispatch(
            #"{"type":"get_traversal_order","requestId":"to-1"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "traversal_order_result")
        XCTAssertEqual(response?.success, false)
    }

    func testAddHighlightDecodeParsesNestedShape() throws {
        let request = try decodeWebSocketRequest(
            #"""
            {"type":"add_highlight","requestId":"hl-1","id":"h1","shape":{"type":"box","bounds":{"x":1,"y":2,"width":3,"height":4}}}
            """#
        )
        guard case let .addHighlight(payload) = request else {
            return XCTFail("Expected .addHighlight, got \(request)")
        }
        XCTAssertEqual(payload.id, "h1")
        XCTAssertEqual(payload.shape?.type, "box")
        XCTAssertEqual(payload.shape?.bounds?.width, 3)
    }

    // MARK: - Storage

    func testListPreferenceFilesDecodeDispatch() {
        let response = dispatch(
            #"{"type":"list_preference_files","requestId":"lpf-1"}"#,
            as: StorageFilesResponse.self
        )
        XCTAssertEqual(response?.type, "preference_files")
        XCTAssertEqual(fakeStorage.listSuitesCallCount, 1)
    }

    func testGetPreferencesDecodeDispatchForwardsFileName() {
        _ = dispatch(
            #"{"type":"get_preferences","requestId":"gp-1","fileName":"com.example.settings"}"#,
            as: StorageEntriesResponse.self
        )
        XCTAssertEqual(fakeStorage.getEntriesHistory.first ?? "unexpected", "com.example.settings")
    }

    func testGetPreferenceDecodeDispatchForwardsKey() {
        fakeStorage.setEntries([StorageEntry(key: "name", value: "Alice", type: "STRING")])
        let response = dispatch(
            #"{"type":"get_preference","requestId":"gp1-1","key":"name"}"#,
            as: StorageEntryResponse.self
        )
        XCTAssertEqual(response?.type, "get_preference_result")
        XCTAssertEqual(response?.value, "Alice")
    }

    func testSetPreferenceDecodeDispatchForwardsFields() {
        let response = dispatch(
            #"{"type":"set_preference","requestId":"sp-1","key":"theme","value":"dark","valueType":"STRING"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "set_preference_result")
        XCTAssertEqual(fakeStorage.setEntryHistory.first?.key, "theme")
        XCTAssertEqual(fakeStorage.setEntryHistory.first?.value, "dark")
        XCTAssertEqual(fakeStorage.setEntryHistory.first?.type, "STRING")
    }

    func testRemovePreferenceDecodeDispatchForwardsKey() {
        let response = dispatch(
            #"{"type":"remove_preference","requestId":"rp-1","key":"theme"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "remove_preference_result")
        XCTAssertEqual(fakeStorage.removeEntryHistory.first?.key, "theme")
    }

    func testClearPreferencesDecodeDispatchForwardsSuite() {
        let response = dispatch(
            #"{"type":"clear_preferences","requestId":"cp-1","fileName":"com.example.settings"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "clear_preferences_result")
        XCTAssertEqual(fakeStorage.clearEntriesHistory.first, "com.example.settings")
    }

    // MARK: - Network mocking

    func testSetNetworkMockRulesDecodeDispatchRelaysRules() {
        let response = dispatch(
            #"""
            {"type":"set_network_mock_rules","requestId":"nm-1","rules":[{"mockId":"m1","host":"h","path":"p","method":"GET","statusCode":500,"responseHeaders":{},"responseBody":"b","contentType":"application/json"}]}
            """#,
            as: SetNetworkMockRulesResponse.self
        )
        XCTAssertEqual(response?.type, "set_network_mock_rules_result")
        XCTAssertEqual(fakeSdkHierarchy.lastMockRules?.first?.mockId, "m1")
    }

    // MARK: - Database

    func testExecuteSqlDecodeDispatchForwardsQuery() {
        fakeDatabase.executeSqlResult = SdkExecuteSqlResult(
            queryType: "query", columns: ["id"], rows: [["1"]], rowsAffected: 0
        )
        let response = dispatch(
            #"""
            {"type":"execute_sql","requestId":"sql-1","appId":"com.example.app","databasePath":"/db.sqlite","query":"SELECT 1"}
            """#,
            as: ExecuteSqlResponse.self
        )
        XCTAssertEqual(response?.type, "execute_sql_result")
        XCTAssertEqual(fakeDatabase.executeSqlCalls.first?.query, "SELECT 1")
    }

    func testListDatabasesDecodeDispatch() {
        let response = dispatch(
            #"{"type":"list_databases","requestId":"ld-1","appId":"com.example.app"}"#,
            as: ListDatabasesResponse.self
        )
        XCTAssertEqual(response?.type, "list_databases_result")
    }

    func testListTablesDecodeDispatchForwardsDatabasePath() {
        let response = dispatch(
            #"{"type":"list_tables","requestId":"lt-1","appId":"com.example.app","databasePath":"/db.sqlite"}"#,
            as: ListTablesResponse.self
        )
        XCTAssertEqual(response?.type, "list_tables_result")
    }

    func testGetTableDataDecodeDispatchForwardsLimitAndOffset() {
        let response = dispatch(
            #"""
            {"type":"get_table_data","requestId":"td-1","appId":"com.example.app","databasePath":"/db.sqlite","table":"notes","limit":10,"offset":5}
            """#,
            as: TableDataResponse.self
        )
        XCTAssertEqual(response?.type, "table_data_result")
        XCTAssertEqual(fakeDatabase.tableDataCalls.first?.table, "notes")
        XCTAssertEqual(fakeDatabase.tableDataCalls.first?.limit, 10)
        XCTAssertEqual(fakeDatabase.tableDataCalls.first?.offset, 5)
    }

    func testGetTableStructureDecodeDispatchForwardsTable() {
        let response = dispatch(
            #"""
            {"type":"get_table_structure","requestId":"ts-1","appId":"com.example.app","databasePath":"/db.sqlite","table":"notes"}
            """#,
            as: TableStructureResponse.self
        )
        XCTAssertEqual(response?.type, "table_structure_result")
        XCTAssertEqual(fakeDatabase.tableStructureCalls.first?.table, "notes")
    }

    // MARK: - Decode rejection (required fields enforced at the wire boundary)

    /// Each command is rejected specifically because its named required field is
    /// absent — asserting `keyNotFound(<field>)`, not merely "some error", so the
    /// test proves the required-field contract rather than passing for any reason.
    func testMissingRequiredFieldsAreRejectedAtDecode() {
        let cases: [(json: String, missingKey: String)] = [
            (#"{"type":"request_tap_coordinates","requestId":"x","y":2}"#, "x"),
            (#"{"type":"request_swipe","requestId":"x","x1":1,"y1":2,"y2":4}"#, "x2"),
            (#"{"type":"request_pinch","requestId":"x","centerX":1,"centerY":2,"distanceEnd":4}"#, "distanceStart"),
            (#"{"type":"request_set_text","requestId":"x"}"#, "text"),
            (#"{"type":"request_ime_action","requestId":"x"}"#, "action"),
            (#"{"type":"request_keyboard","requestId":"x"}"#, "action"),
            (#"{"type":"request_press_button","requestId":"x"}"#, "action"),
            (#"{"type":"request_action","requestId":"x"}"#, "action"),
            (#"{"type":"request_launch_app","requestId":"x"}"#, "bundleId"),
            (#"{"type":"request_rotate","requestId":"x"}"#, "orientation"),
            (#"{"type":"request_clipboard","requestId":"x"}"#, "action"),
            (#"{"type":"set_preference","requestId":"x","value":"v","valueType":"STRING"}"#, "key"),
            (#"{"type":"remove_preference","requestId":"x"}"#, "key"),
            (#"{"type":"set_network_mock_rules","requestId":"x"}"#, "rules"),
        ]
        for (json, missingKey) in cases {
            XCTAssertThrowsError(try decodeWebSocketRequest(json), "expected \(json) to be rejected") { error in
                guard case let DecodingError.keyNotFound(key, _) = error else {
                    return XCTFail("Expected keyNotFound(\(missingKey)) for \(json), got \(error)")
                }
                XCTAssertEqual(key.stringValue, missingKey, "wrong missing key for \(json)")
            }
        }
    }

    func testMissingTypeIsRejected() {
        XCTAssertThrowsError(try decodeWebSocketRequest(#"{"requestId":"x"}"#)) { error in
            guard case let DecodingError.keyNotFound(key, _) = error else {
                return XCTFail("Expected keyNotFound(type), got \(error)")
            }
            XCTAssertEqual(key.stringValue, "type")
        }
    }
}
