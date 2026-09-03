@testable import CtrlProxy
import XCTest

/// Decodes a raw JSON command string into the typed `WebSocketRequest` enum,
/// exercising the same `JSONDecoder().decode(WebSocketRequest.self, …)` path the
/// `WebSocketServer` uses on the wire. Shared across the CtrlProxy test target.
func decodeWebSocketRequest(_ json: String) throws -> WebSocketRequest {
    try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
}

/// A minimal `CodingKey` for building synthetic `DecodingError`s whose `codingPath`
/// pins a specific field name — used to test the field-attributed decode messages
/// deterministically, independent of the host decoder backend (#2986).
struct TestCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        self.intValue = intValue
        stringValue = String(intValue)
    }

    /// Non-failable convenience for building a synthetic array-index coding key
    /// without a force-unwrap in tests.
    static func index(_ value: Int) -> TestCodingKey {
        TestCodingKey(stringValue: "Index \(value)", intValue: value)
    }

    private init(stringValue: String, intValue: Int?) {
        self.stringValue = stringValue
        self.intValue = intValue
    }
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
    var fakeHierarchyDebouncer: FakeHierarchyDebouncer!
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
        fakeHierarchyDebouncer = FakeHierarchyDebouncer()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: perfProvider,
            storageInspector: fakeStorage,
            sdkHierarchyClient: fakeSdkHierarchy,
            sdkDatabaseClient: fakeDatabase,
            hierarchyDebouncer: fakeHierarchyDebouncer
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
            .setHierarchyPollInterval: #"{"intervalMs":500}"#,
            .requestScreenshot: "{}",
            .requestTapCoordinates: #"{"x":1,"y":2}"#,
            .requestSwipe: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestTwoFingerSwipe: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestMultiFingerSwipe: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestDrag: #"{"x1":1,"y1":2,"x2":3,"y2":4}"#,
            .requestPinch: #"{"centerX":1,"centerY":2,"distanceStart":3,"distanceEnd":4}"#,
            .requestSetText: #"{"text":"hi"}"#,
            .requestAppendText: #"{"text":"hi"}"#,
            .requestClearText: "{}",
            .requestImeAction: #"{"action":"done"}"#,
            .requestSelectAll: "{}",
            .requestKeyboard: #"{"action":"open"}"#,
            .requestPressKey: #"{"key":"tab","modifiers":["shift"]}"#,
            .requestPressButton: #"{"action":"home"}"#,
            .requestPressHome: "{}",
            .requestPressBack: "{}",
            .requestShake: "{}",
            .requestRecentApps: "{}",
            .requestAction: #"{"action":"tap"}"#,
            .requestActivateAccessibilityLink: #"{"text":"Terms of Service","occurrence":0}"#,
            .requestLaunchApp: #"{"bundleId":"com.example.app"}"#,
            .requestRotate: #"{"orientation":"portrait"}"#,
            .requestClipboard: #"{"action":"get"}"#,
            .getCurrentFocus: "{}",
            .getTraversalOrder: "{}",
            .addHighlight: "{}",
            .getVoiceOverState: "{}",
            .setVoiceOverState: #"{"enabled":true}"#,
            .listPreferenceFiles: "{}",
            .getPreferences: "{}",
            .getPreference: "{}",
            .setPreference: #"{"key":"k","valueType":"STRING"}"#,
            .removePreference: #"{"key":"k"}"#,
            .clearPreferences: "{}",
            .setNetworkMockRules: #"{"rules":[]}"#,
            .setNetworkFaultRules: #"{"rules":[]}"#,
            .setNetworkErrorSimulation: #"{"enabled":false}"#,
            .executeSql: "{}",
            .listDatabases: "{}",
            .storageCapabilities: "{}",
            .listTables: "{}",
            .getTableData: "{}",
            .getTableStructure: "{}",
            .requestResetPermissions: #"{"bundleId":"com.example.app","permissions":["camera"]}"#,
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

    /// Negative fractional coordinates are a legitimate computed input (e.g. an
    /// off-screen anchor or a delta relative to an origin). Asserts the exact
    /// values survive at the payload-decode boundary — not merely that decode
    /// did not throw — so a future accidental re-narrowing to `Int` (which would
    /// truncate the fraction and reject nothing) is caught.
    func testGestureCoordinatesDecodeNegativeFractionalAtBoundary() throws {
        let request = try decodeWebSocketRequest(
            #"{"type":"request_swipe","requestId":"neg-1","x1":-5.5,"y1":0.25,"x2":30.75,"y2":-40.5}"#
        )
        guard case let .swipe(payload) = request else {
            return XCTFail("Expected .swipe, got \(request)")
        }
        XCTAssertEqual(payload.x1, -5.5, accuracy: 0.0001)
        XCTAssertEqual(payload.y1, 0.25, accuracy: 0.0001)
        XCTAssertEqual(payload.x2, 30.75, accuracy: 0.0001)
        XCTAssertEqual(payload.y2, -40.5, accuracy: 0.0001)
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

    func testAppendTextDecodeDispatchUsesFocusedFieldInsert() {
        _ = dispatch(
            #"{"type":"request_append_text","requestId":"append-1","text":"a"}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(fakeGesturePerformer.getAppendTextHistory(), ["a"])
        XCTAssertTrue(fakeGesturePerformer.getSetTextHistory().isEmpty)
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

    // MARK: - Reset permissions

    func testResetPermissionsDecodeDispatchForwardsResources() {
        let response = dispatch(
            #"{"type":"request_reset_permissions","requestId":"rp-1","bundleId":"com.example.app","permissions":["camera","photos"]}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.type, "reset_permissions_result")
        XCTAssertEqual(response?.requestId, "rp-1")
        let history = fakeGesturePerformer.getResetAuthorizationsHistory()
        XCTAssertEqual(history.first?.bundleId, "com.example.app")
        XCTAssertEqual(history.first?.resources, ["camera", "photos"])
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

    func testSetHierarchyPollIntervalDecodeDispatchUpdatesDebouncer() {
        let response = dispatch(
            #"{"type":"set_hierarchy_poll_interval","requestId":"poll-1","intervalMs":500}"#,
            as: WebSocketResponse.self
        )

        XCTAssertEqual(response?.type, "set_hierarchy_poll_interval_result")
        XCTAssertEqual(response?.requestId, "poll-1")
        XCTAssertEqual(response?.success, true)
        XCTAssertEqual(fakeHierarchyDebouncer.updatePollIntervalMsCallCount, 1)
        XCTAssertEqual(fakeHierarchyDebouncer.lastPollIntervalMs, 500)
    }

    func testScreenshotDecodeDispatch() {
        let response = dispatch(
            #"{"type":"request_screenshot","requestId":"ss-1"}"#,
            as: ScreenshotResponse.self
        )
        XCTAssertEqual(response?.type, "screenshot")
        XCTAssertEqual(response?.requestId, "ss-1")
        XCTAssertEqual(response?.rotation, 0)
    }

    func testScreenshotDecodeDispatchUsesCaptureRotation() {
        fakeGesturePerformer.setScreenshotCapture(
            ScreenshotCapture(data: Data(), rotation: 3)
        )

        let response = dispatch(
            #"{"type":"request_screenshot","requestId":"ss-capture-rotation"}"#,
            as: ScreenshotResponse.self
        )

        XCTAssertEqual(response?.rotation, 3)
        XCTAssertEqual(fakeGesturePerformer.getScreenshotCallCount(), 1)
    }

    // MARK: - Accessibility

    func testGetVoiceOverStateDecodeDispatch() {
        let response = dispatch(
            #"{"type":"get_voiceover_state","requestId":"vo-1"}"#,
            as: VoiceOverStateResponse.self
        )
        XCTAssertEqual(response?.type, "voiceover_state_result")
    }

    // #3924: both commands are implemented now — they answer from the SDK-enriched
    // hierarchy instead of returning the old "not yet implemented" error.
    func testGetCurrentFocusDecodeDispatch() {
        let response = dispatch(
            #"{"type":"get_current_focus","requestId":"cf-1"}"#,
            as: CurrentFocusResponse.self
        )
        XCTAssertEqual(response?.type, "current_focus_result")
        XCTAssertEqual(response?.requestId, "cf-1")
        XCTAssertEqual(response?.success, true)
    }

    func testGetTraversalOrderDecodeDispatch() {
        let response = dispatch(
            #"{"type":"get_traversal_order","requestId":"to-1"}"#,
            as: TraversalOrderResponse.self
        )
        XCTAssertEqual(response?.type, "traversal_order_result")
        XCTAssertEqual(response?.requestId, "to-1")
        XCTAssertEqual(response?.success, true)
        XCTAssertEqual(response?.totalCount, response?.elements.count)
    }

    // MARK: - VoiceOver focus / traversal helpers (#3924)

    /// Build an element tree: root > [container > [a11yChild], plainChild]
    private func makeAccessibilityTree(focusedLabel: String?) -> UIElementInfo {
        func element(_ label: String, isA11y: Bool, children: [UIElementInfo]? = nil) -> UIElementInfo {
            UIElementInfo(
                text: label,
                className: "View",
                bounds: ElementBounds(left: 0, top: 0, right: 10, bottom: 10),
                accessibilityFocused: label == focusedLabel ? "true" : nil,
                extras: ["sdk.isAccessibilityElement": isA11y ? "true" : "false"],
                node: children
            )
        }
        let a11yChild = element("a11yChild", isA11y: true)
        let container = element("container", isA11y: false, children: [a11yChild])
        let plainChild = element("plainChild", isA11y: true)
        return element("root", isA11y: false, children: [container, plainChild])
    }

    func testFindAccessibilityFocusedLocatesNestedFocusedElement() {
        let tree = makeAccessibilityTree(focusedLabel: "a11yChild")
        let focused = CommandHandler.findAccessibilityFocused(tree)
        XCTAssertEqual(focused?.text, "a11yChild")
    }

    func testFindAccessibilityFocusedReturnsNilWhenCursorAbsent() {
        let tree = makeAccessibilityTree(focusedLabel: nil)
        XCTAssertNil(CommandHandler.findAccessibilityFocused(tree))
    }

    func testCollectAccessibilityElementsReturnsOnlyA11yElementsInTraversalOrder() {
        let tree = makeAccessibilityTree(focusedLabel: nil)
        var ordered: [UIElementInfo] = []
        CommandHandler.collectAccessibilityElements(tree, into: &ordered)
        // Containers are traversed into but not themselves reported.
        XCTAssertEqual(ordered.map(\.text), ["a11yChild", "plainChild"])
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

    func testSetNetworkErrorSimulationDecodeDispatchRelaysConfig() {
        let response = dispatch(
            #"""
            {"type":"set_network_error_simulation","requestId":"nes-1","enabled":true,"errorType":"tlsFailure","limit":3,"expiresAtEpochMs":1720000000000}
            """#,
            as: SetNetworkErrorSimulationResponse.self
        )
        XCTAssertEqual(response?.type, "set_network_error_simulation_result")
        XCTAssertEqual(fakeSdkHierarchy.lastNetworkErrorSimulation?.enabled, true)
        XCTAssertEqual(fakeSdkHierarchy.lastNetworkErrorSimulation?.errorType, "tlsFailure")
        XCTAssertEqual(fakeSdkHierarchy.lastNetworkErrorSimulation?.limit, 3)
        XCTAssertEqual(fakeSdkHierarchy.lastNetworkErrorSimulation?.expiresAtEpochMs, 1_720_000_000_000)
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
            (#"{"type":"request_reset_permissions","requestId":"x","permissions":["camera"]}"#, "bundleId"),
            (#"{"type":"request_reset_permissions","requestId":"x","bundleId":"com.example.app"}"#, "permissions"),
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

    // MARK: - Non-finite coordinate rejection (#2928)

    /// Assert that a gesture handler rejected a non-finite coordinate: the
    /// response is a clean, actionable structured error (`success == false`, the
    /// command's own result `type`, an `invalidParameter`-style message naming
    /// the field) rather than an opaque failure — and that nothing was dispatched
    /// into the gesture engine.
    private func assertRejectedNonFinite(
        _ response: WebSocketResponse?,
        type: String,
        field: String,
        file: StaticString = #file,
        line: UInt = #line
    ) {
        guard let response = response else {
            return XCTFail("Expected a WebSocketResponse, got nil", file: file, line: line)
        }
        XCTAssertEqual(response.type, type, "wrong result type", file: file, line: line)
        XCTAssertEqual(response.success, false, "expected failure response", file: file, line: line)
        let message = response.error ?? ""
        XCTAssertTrue(
            message.contains("Invalid value") && message.contains(field),
            "error should name the invalid field '\(field)', got: \(message)",
            file: file,
            line: line
        )
    }

    /// A non-finite coordinate reaching each gesture handler is rejected with a
    /// clean per-command error response and never dispatched to the gesture
    /// engine — one case per gesture family, covering `+Infinity`, `-Infinity`,
    /// and `NaN`.
    ///
    /// Wire note: Apple's `JSONDecoder` rejects an overflow literal like `1e309`
    /// at pre-parse (see `testOverflowCoordinateLiteralIsRejectedAtDecode`), so a
    /// non-finite `Double` cannot arrive over the wire today. This guard is
    /// defense-in-depth for the typed-initializer / computed-coordinate path
    /// (division, `hypot`, normalized offsets) where a non-finite value can
    /// legitimately originate.
    func testNonFiniteTapCoordinateIsRejected() {
        let response = commandHandler.handle(.tapCoordinates(
            RequestTapCoordinates(requestId: "tap-inf", x: .infinity, y: 200)
        )) as? WebSocketResponse
        assertRejectedNonFinite(response, type: "tap_coordinates_result", field: "x")
        XCTAssertTrue(fakeGesturePerformer.getTapHistory().isEmpty, "tap must not reach the engine")
    }

    func testNonFiniteSwipeCoordinateIsRejected() {
        let response = commandHandler.handle(.swipe(
            RequestSwipe(requestId: "swipe-inf", x1: 10, y1: 20, x2: 30, y2: -.infinity)
        )) as? WebSocketResponse
        assertRejectedNonFinite(response, type: "swipe_result", field: "y2")
        XCTAssertTrue(fakeGesturePerformer.getSwipeHistory().isEmpty, "swipe must not reach the engine")
    }

    func testNonFiniteMultiFingerSwipeCoordinateIsRejected() {
        let response = commandHandler.handle(.multiFingerSwipe(
            RequestMultiFingerSwipe(requestId: "mfs-nan", x1: .nan, y1: 20, x2: 30, y2: 40, fingerCount: 3)
        )) as? WebSocketResponse
        assertRejectedNonFinite(response, type: "multi_finger_swipe_result", field: "x1")
        XCTAssertTrue(
            fakeGesturePerformer.getMultiFingerSwipeHistory().isEmpty,
            "multi-finger swipe must not reach the engine"
        )
    }

    func testNonFiniteDragCoordinateIsRejected() {
        let response = commandHandler.handle(.drag(
            RequestDrag(requestId: "drag-inf", x1: 10, y1: 20, x2: .infinity, y2: 40)
        )) as? WebSocketResponse
        assertRejectedNonFinite(response, type: "drag_result", field: "x2")
        XCTAssertTrue(fakeGesturePerformer.getDragHistory().isEmpty, "drag must not reach the engine")
    }

    func testNonFinitePinchCoordinateIsRejected() {
        let response = commandHandler.handle(.pinch(
            RequestPinch(requestId: "pinch-nan", centerX: 100, centerY: 200, distanceStart: 40, distanceEnd: .nan)
        )) as? WebSocketResponse
        assertRejectedNonFinite(response, type: "pinch_result", field: "distanceEnd")
        XCTAssertTrue(fakeGesturePerformer.getPinchHistory().isEmpty, "pinch must not reach the engine")
    }

    /// `rotationDegrees` is a `Float?`, not a coordinate, but it flows into the
    /// pinch gesture-path math (degrees → radians → cos/sin), so a computed
    /// non-finite rotation is rejected at the handler boundary too — the iOS
    /// mirror of Android #2964 / PR #2984 (#2991). Covers all three non-finite
    /// `Float` values.
    func testNonFinitePinchRotationIsRejected() {
        for bad in [Float.infinity, -Float.infinity, Float.nan] {
            let response = commandHandler.handle(.pinch(RequestPinch(
                requestId: "pinch-rot",
                centerX: 100,
                centerY: 200,
                distanceStart: 40,
                distanceEnd: 80,
                rotationDegrees: bad
            ))) as? WebSocketResponse
            assertRejectedNonFinite(response, type: "pinch_result", field: "rotationDegrees")
            XCTAssertTrue(
                fakeGesturePerformer.getPinchHistory().isEmpty,
                "pinch with rotationDegrees=\(bad) must not reach the engine"
            )
        }
    }

    /// Finite rotations — the default (`nil` → 0), zero, negative, and fractional
    /// degrees — pass the guard unchanged and are forwarded to the engine.
    func testFinitePinchRotationStillDispatches() {
        let cases: [(rotation: Float?, forwarded: Double)] = [
            (nil, 0),
            (0, 0),
            (-90, -90),
            (22.5, 22.5),
        ]
        for (rotation, forwarded) in cases {
            fakeGesturePerformer.clearHistory()
            let response = commandHandler.handle(.pinch(RequestPinch(
                requestId: "pinch-ok",
                centerX: 100,
                centerY: 200,
                distanceStart: 40,
                distanceEnd: 80,
                rotationDegrees: rotation
            ))) as? WebSocketResponse
            XCTAssertEqual(response?.success, true, "finite rotation \(String(describing: rotation)) must succeed")
            let history = fakeGesturePerformer.getPinchHistory()
            XCTAssertEqual(history.count, 1)
            XCTAssertEqual(history.first?.rotationDegrees, forwarded)
        }
    }

    /// iOS `offset` (multi-finger spacing) is a `Double?` — unlike Android's
    /// `Int`, which cannot be non-finite and is deliberately unguarded there — so
    /// a computed non-finite spacing gets the same defense-in-depth guard (#2991).
    func testNonFiniteMultiFingerSwipeOffsetIsRejected() {
        for bad in [Double.infinity, -.infinity, .nan] {
            let response = commandHandler.handle(.multiFingerSwipe(RequestMultiFingerSwipe(
                requestId: "mfs-offset",
                x1: 10,
                y1: 20,
                x2: 30,
                y2: 40,
                fingerCount: 3,
                offset: bad
            ))) as? WebSocketResponse
            assertRejectedNonFinite(response, type: "multi_finger_swipe_result", field: "offset")
            XCTAssertTrue(
                fakeGesturePerformer.getMultiFingerSwipeHistory().isEmpty,
                "multi-finger swipe with offset=\(bad) must not reach the engine"
            )
        }
    }

    /// Finite offsets — the default (`nil` → 25), fractional, and zero — pass the
    /// guard and are forwarded as the finger spacing.
    func testFiniteMultiFingerSwipeOffsetStillDispatches() {
        let cases: [(offset: Double?, forwarded: Double)] = [
            (nil, 25),
            (0, 0),
            (12.5, 12.5),
        ]
        for (offset, forwarded) in cases {
            fakeGesturePerformer.clearHistory()
            let response = commandHandler.handle(.multiFingerSwipe(RequestMultiFingerSwipe(
                requestId: "mfs-ok",
                x1: 10,
                y1: 20,
                x2: 30,
                y2: 40,
                fingerCount: 3,
                offset: offset
            ))) as? WebSocketResponse
            XCTAssertEqual(response?.success, true, "finite offset \(String(describing: offset)) must succeed")
            let history = fakeGesturePerformer.getMultiFingerSwipeHistory()
            XCTAssertEqual(history.count, 1)
            XCTAssertEqual(history.first?.fingerSpacing, forwarded)
        }
    }

    /// The two-finger alias routes through the same multi-finger handler, so it
    /// gets the same guard.
    func testNonFiniteTwoFingerSwipeCoordinateIsRejected() {
        let response = commandHandler.handle(.twoFingerSwipe(
            RequestMultiFingerSwipe(requestId: "tfs-inf", x1: 10, y1: .infinity, x2: 30, y2: 40)
        )) as? WebSocketResponse
        assertRejectedNonFinite(response, type: "multi_finger_swipe_result", field: "y1")
        XCTAssertTrue(
            fakeGesturePerformer.getMultiFingerSwipeHistory().isEmpty,
            "two-finger swipe must not reach the engine"
        )
    }

    /// Exhaustively pin *every* coordinate field of *every* gesture family: set
    /// exactly one coordinate non-finite (all others valid) and assert the guard
    /// rejects that specific field and dispatches nothing — across `+Infinity`,
    /// `-Infinity`, and `NaN`. Because `requireFinite` short-circuits on the first
    /// bad field, the per-family tests above only prove the first-checked field;
    /// this loop proves each trailing `requireFinite` call is load-bearing (a
    /// deleted `requireFinite(request.y…)` line would fail here).
    func testEveryCoordinateFieldIsIndividuallyGuarded() {
        let base: [Double] = [11, 22, 33, 44]

        func check(
            family: String,
            fields: [String],
            resultType: String,
            make: ([Double]) -> WebSocketRequest,
            dispatched: () -> Bool,
            line: UInt = #line
        ) {
            for (index, field) in fields.enumerated() {
                for bad in [Double.infinity, -.infinity, .nan] {
                    var coords = base
                    coords[index] = bad
                    let response = commandHandler.handle(make(coords)) as? WebSocketResponse
                    assertRejectedNonFinite(response, type: resultType, field: field, line: line)
                    XCTAssertFalse(dispatched(), "\(family) \(field)=\(bad) must not dispatch", line: line)
                }
            }
        }

        check(
            family: "tap",
            fields: ["x", "y"],
            resultType: "tap_coordinates_result",
            make: { .tapCoordinates(RequestTapCoordinates(x: $0[0], y: $0[1])) },
            dispatched: { !self.fakeGesturePerformer.getTapHistory().isEmpty }
        )
        check(
            family: "swipe",
            fields: ["x1", "y1", "x2", "y2"],
            resultType: "swipe_result",
            make: { .swipe(RequestSwipe(x1: $0[0], y1: $0[1], x2: $0[2], y2: $0[3])) },
            dispatched: { !self.fakeGesturePerformer.getSwipeHistory().isEmpty }
        )
        check(
            family: "multiFingerSwipe",
            fields: ["x1", "y1", "x2", "y2"],
            resultType: "multi_finger_swipe_result",
            make: { .multiFingerSwipe(RequestMultiFingerSwipe(x1: $0[0], y1: $0[1], x2: $0[2], y2: $0[3])) },
            dispatched: { !self.fakeGesturePerformer.getMultiFingerSwipeHistory().isEmpty }
        )
        check(
            family: "drag",
            fields: ["x1", "y1", "x2", "y2"],
            resultType: "drag_result",
            make: { .drag(RequestDrag(x1: $0[0], y1: $0[1], x2: $0[2], y2: $0[3])) },
            dispatched: { !self.fakeGesturePerformer.getDragHistory().isEmpty }
        )
        check(
            family: "pinch",
            fields: ["centerX", "centerY", "distanceStart", "distanceEnd"],
            resultType: "pinch_result",
            make: {
                .pinch(RequestPinch(centerX: $0[0], centerY: $0[1], distanceStart: $0[2], distanceEnd: $0[3]))
            },
            dispatched: { !self.fakeGesturePerformer.getPinchHistory().isEmpty }
        )
    }

    /// Documents the decode-boundary reality behind #2928: an overflow numeric
    /// literal is rejected by `JSONDecoder` during pre-parse (`dataCorrupted`,
    /// empty codingPath) — it does NOT coerce to `Double.infinity`. So no wire
    /// payload can deliver a non-finite coordinate to the handler on Apple
    /// Foundation; the `isFinite` guard defends the non-wire construction path.
    func testOverflowCoordinateLiteralIsRejectedAtDecode() {
        XCTAssertThrowsError(
            try decodeWebSocketRequest(#"{"type":"request_tap_coordinates","x":1e309,"y":2}"#)
        ) { error in
            guard case DecodingError.dataCorrupted = error else {
                return XCTFail("Expected dataCorrupted for an overflow literal, got \(error)")
            }
        }
    }

    // MARK: - Decode-boundary wire-message legibility (#2965)

    /// Build a synthetic `DecodingError.dataCorrupted` whose underlying Cocoa 3840
    /// error carries `debugDescription` in `NSDebugDescription` — mirroring exactly
    /// what `JSONDecoder` attaches. This lets a test pin the rewrite of a *specific*
    /// backend phrasing (e.g. the classic iOS 15–17 "wound up as NaN" overflow text)
    /// deterministically on any host, independent of which `JSONDecoder` backend the
    /// test machine happens to run.
    private func syntheticDataCorrupted(underlyingDebugDescription: String) -> DecodingError {
        let underlying = NSError(
            domain: NSCocoaErrorDomain,
            code: 3840,
            userInfo: [NSDebugDescriptionErrorKey: underlyingDebugDescription]
        )
        let context = DecodingError.Context(
            codingPath: [],
            debugDescription: "The given data was not valid JSON.",
            underlyingError: underlying
        )
        return DecodingError.dataCorrupted(context)
    }

    /// Feed a caught error through the real `WebSocketServer.buildErrorResponseData`
    /// wire encoder (the same path `handleMessage`'s catch block uses) and return
    /// the surfaced `error` string, asserting the envelope is a well-formed
    /// structured error along the way.
    private func wireErrorMessage(
        for error: Error,
        requestId: String?,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> String
    {
        let data = WebSocketServer.buildErrorResponseData(requestId: requestId, error: error)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("error response was not valid JSON", file: file, line: line)
            return ""
        }
        XCTAssertEqual(json["type"] as? String, "error", "wrong envelope type", file: file, line: line)
        XCTAssertEqual(json["success"] as? Bool, false, "error envelope must be success=false", file: file, line: line)
        if let requestId = requestId {
            XCTAssertEqual(json["requestId"] as? String, requestId, "requestId preserved", file: file, line: line)
        }
        guard let message = json["error"] as? String else {
            XCTFail("error envelope missing 'error' string", file: file, line: line)
            return ""
        }
        return message
    }

    /// Capture the error `JSONDecoder` throws for a raw command string. Fails the
    /// test if decoding unexpectedly succeeds.
    private func decodeError(
        _ json: String,
        file: StaticString = #file,
        line: UInt = #line
    )
        -> Error
    {
        do {
            _ = try decodeWebSocketRequest(json)
            XCTFail("expected \(json) to fail decoding", file: file, line: line)
            return NSError(domain: "test", code: 0)
        } catch {
            return error
        }
    }

    /// AC1: an out-of-range numeric literal (`1e309`) — rejected by `JSONDecoder`
    /// at pre-parse with an empty `codingPath` — surfaces an *actionable* wire
    /// message ("out of range" / "not representable"), not the opaque
    /// "…isn't in the correct format." The value is still rejected (this is
    /// diagnostic legibility only), and the requestId is preserved for correlation.
    func testOverflowLiteralWireMessageIsActionable() {
        let error = decodeError(#"{"type":"request_tap_coordinates","requestId":"ovf-1","x":1e309,"y":2}"#)
        let message = wireErrorMessage(for: error, requestId: "ovf-1")
        // The rewrite must change the surfaced string from the decoder's opaque
        // default. Compared against the *actual* `localizedDescription` (whose exact
        // wording/apostrophe is Foundation-controlled), not a hand-typed literal.
        XCTAssertNotEqual(
            message,
            error.localizedDescription,
            "overflow message must not stay the opaque decoder default, got: \(message)"
        )
        let lowered = message.lowercased()
        XCTAssertTrue(
            lowered.contains("out of range") || lowered.contains("not representable"),
            "overflow message should name the out-of-range/non-representable cause, got: \(message)"
        )
    }

    /// A larger overflow literal decodes to the same class of failure and is
    /// rewritten the same way — proves the detection keys off the underlying Cocoa
    /// error, not a hard-coded `1e309` string.
    func testLargerOverflowLiteralWireMessageIsActionable() {
        let error = decodeError(#"{"type":"request_swipe","requestId":"ovf-2","x1":1,"y1":2,"x2":1e400,"y2":4}"#)
        let message = wireErrorMessage(for: error, requestId: "ovf-2")
        XCTAssertNotEqual(message, error.localizedDescription, "got: \(message)")
        let lowered = message.lowercased()
        XCTAssertTrue(
            lowered.contains("out of range") || lowered.contains("not representable"),
            "got: \(message)"
        )
    }

    /// The runner deploys to `.iOS(.v15)` (`Package.swift`), where `JSONDecoder` is
    /// backed by classic `JSONSerialization`, which phrases an overflow literal as
    /// "Number wound up as NaN around line 1, column 5." — NOT "not representable"
    /// (the swift-foundation phrasing on iOS 18+/macOS 15+). Both must map to the
    /// same actionable out-of-range message; matching only "not representable" would
    /// silently miss the overflow case on iOS 15–17. This test pins the classic
    /// phrasing deterministically regardless of the CI host's decoder backend.
    func testClassicFoundationOverflowPhrasingIsActionable() {
        let classic = syntheticDataCorrupted(
            underlyingDebugDescription: "Number wound up as NaN around line 1, column 5."
        )
        let message = wireErrorMessage(for: classic, requestId: "ovf-classic")
        let lowered = message.lowercased()
        XCTAssertTrue(
            lowered.contains("out of range") || lowered.contains("not representable"),
            "classic-Foundation overflow phrasing must map to the out-of-range message, got: \(message)"
        )
    }

    /// The swift-foundation (iOS 18+/macOS 15+) overflow phrasing maps to the same
    /// actionable message — pinned deterministically alongside the classic one so a
    /// change to either backend's handling is caught regardless of the test host.
    func testModernFoundationOverflowPhrasingIsActionable() {
        let modern = syntheticDataCorrupted(
            underlyingDebugDescription: "Number 1e309 is not representable in Swift."
        )
        let message = wireErrorMessage(for: modern, requestId: "ovf-modern")
        let lowered = message.lowercased()
        XCTAssertTrue(
            lowered.contains("out of range") || lowered.contains("not representable"),
            "swift-foundation overflow phrasing must map to the out-of-range message, got: \(message)"
        )
    }

    /// AC2: a missing-required-field rejection (`keyNotFound`) is NOT a
    /// `dataCorrupted` error, so the rewrite must leave its wire message exactly
    /// equal to `error.localizedDescription` — the `keyNotFound` contract that
    /// `TypedRequestDecodeTests` relies on stays byte-for-byte unchanged.
    func testKeyNotFoundWireMessageUnchanged() {
        let error = decodeError(#"{"type":"request_tap_coordinates","requestId":"kn-1","y":2}"#)
        guard case DecodingError.keyNotFound = error else {
            return XCTFail("expected keyNotFound, got \(error)")
        }
        let message = wireErrorMessage(for: error, requestId: "kn-1")
        XCTAssertEqual(
            message,
            error.localizedDescription,
            "keyNotFound wire message must be untouched by the dataCorrupted rewrite"
        )
    }

    /// AC3: an unknown command type throws `CommandError.unknownCommand` (a
    /// `LocalizedError`, not a `DecodingError`) at decode; its wire text must stay
    /// exactly "Unknown command type: <type>" so the TS client's
    /// `rewriteUnknownCommandError` regex still matches it.
    func testUnknownCommandWireMessageUntouched() {
        let error = decodeError(#"{"type":"unknown_command","requestId":"uc-1"}"#)
        let message = wireErrorMessage(for: error, requestId: "uc-1")
        XCTAssertEqual(message, "Unknown command type: unknown_command")
    }

    /// Generic malformed JSON (also `dataCorrupted`) becomes actionable too — it
    /// names "not valid JSON" instead of the opaque decoder default.
    func testMalformedJsonWireMessageIsActionable() {
        let error = decodeError(#"{"type":"request_tap_coordinates","x":,}"#)
        let message = wireErrorMessage(for: error, requestId: nil)
        XCTAssertNotEqual(message, error.localizedDescription, "got: \(message)")
        XCTAssertTrue(
            message.lowercased().contains("not valid json") || message.lowercased().contains("malformed"),
            "malformed JSON should surface an actionable cause, got: \(message)"
        )
    }

    // MARK: - Field-attributed decode legibility: typeMismatch / valueNotFound (#2986)

    /// Build a synthetic `DecodingError.typeMismatch` with a single-key
    /// `codingPath` — mirroring what `JSONDecoder` throws when a field holds the
    /// wrong JSON type. Lets a test pin the field-attributed rewrite deterministically
    /// on any host regardless of the decoder backend's exact `debugDescription`.
    private func syntheticTypeMismatch(field: String, debugDescription: String) -> DecodingError {
        let context = DecodingError.Context(
            codingPath: [TestCodingKey(stringValue: field)],
            debugDescription: debugDescription
        )
        return DecodingError.typeMismatch(Double.self, context)
    }

    /// Build a synthetic `DecodingError.valueNotFound` with a single-key `codingPath`.
    private func syntheticValueNotFound(field: String, debugDescription: String) -> DecodingError {
        let context = DecodingError.Context(
            codingPath: [TestCodingKey(stringValue: field)],
            debugDescription: debugDescription
        )
        return DecodingError.valueNotFound(Double.self, context)
    }

    /// AC1 (#2986): a `typeMismatch` inbound command (a field holding the wrong JSON
    /// type, e.g. a string where a number is expected) — which carries a non-empty
    /// `codingPath` — surfaces a *field-attributed* actionable message naming the
    /// offending field, instead of the opaque "…isn't in the correct format." The
    /// value is still rejected (diagnostic legibility only) and the requestId is
    /// preserved. Uses the *real* wire decode path so the codingPath is genuine.
    func testTypeMismatchWireMessageIsFieldAttributed() {
        let error = decodeError(#"{"type":"request_tap_coordinates","requestId":"tm-1","x":"hi","y":2}"#)
        guard case DecodingError.typeMismatch = error else {
            return XCTFail("expected typeMismatch, got \(error)")
        }
        let message = wireErrorMessage(for: error, requestId: "tm-1")
        XCTAssertNotEqual(
            message,
            error.localizedDescription,
            "typeMismatch message must not stay the opaque decoder default, got: \(message)"
        )
        XCTAssertTrue(
            message.contains("'x'"),
            "typeMismatch message should name the offending field 'x', got: \(message)"
        )
        XCTAssertTrue(
            message.lowercased().contains("wrong type") || message.lowercased().contains("type"),
            "typeMismatch message should indicate a wrong type, got: \(message)"
        )
    }

    /// AC1 (#2986): a `valueNotFound` inbound command (a field present but `null`
    /// where a non-optional value is required) surfaces a field-attributed message
    /// naming the field. `valueNotFound` carries a non-empty `codingPath`, so it is
    /// fair game for attribution (unlike `keyNotFound`).
    func testValueNotFoundWireMessageIsFieldAttributed() {
        let error = decodeError(#"{"type":"request_tap_coordinates","requestId":"vnf-1","x":null,"y":2}"#)
        guard case DecodingError.valueNotFound = error else {
            return XCTFail("expected valueNotFound, got \(error)")
        }
        let message = wireErrorMessage(for: error, requestId: "vnf-1")
        XCTAssertNotEqual(
            message,
            error.localizedDescription,
            "valueNotFound message must not stay the opaque decoder default, got: \(message)"
        )
        XCTAssertTrue(
            message.contains("'x'"),
            "valueNotFound message should name the offending field 'x', got: \(message)"
        )
        XCTAssertTrue(
            message.lowercased().contains("missing") || message.lowercased().contains("null"),
            "valueNotFound message should indicate a missing/null value, got: \(message)"
        )
    }

    /// A `typeMismatch` on a *nested* field is attributed to the deepest key in the
    /// `codingPath` (the actual field), pinned deterministically via a synthetic
    /// error so it does not depend on the host decoder's `debugDescription` wording.
    func testSyntheticTypeMismatchNamesDeepestField() {
        let error = syntheticTypeMismatch(
            field: "distanceStart",
            debugDescription: "Expected to decode Double but found a string instead."
        )
        let message = wireErrorMessage(for: error, requestId: "syn-tm")
        XCTAssertTrue(
            message.contains("'distanceStart'"),
            "should name the deepest coding-path field, got: \(message)"
        )
    }

    /// A synthetic `valueNotFound` is likewise field-attributed and deterministic.
    func testSyntheticValueNotFoundNamesField() {
        let error = syntheticValueNotFound(
            field: "x2",
            debugDescription: "Expected Double value but found null instead."
        )
        let message = wireErrorMessage(for: error, requestId: "syn-vnf")
        XCTAssertTrue(
            message.contains("'x2'"),
            "should name the coding-path field, got: \(message)"
        )
    }

    /// A `typeMismatch` with an *empty* codingPath (no field to attribute) must still
    /// produce an actionable, non-opaque message — just without a field name.
    func testTypeMismatchWithoutFieldIsStillActionable() {
        let context = DecodingError.Context(
            codingPath: [],
            debugDescription: "Expected to decode Array<Any> but found a dictionary instead."
        )
        let error = DecodingError.typeMismatch([Double].self, context)
        let message = wireErrorMessage(for: error, requestId: "tm-nofield")
        XCTAssertNotEqual(message, error.localizedDescription, "got: \(message)")
        XCTAssertTrue(
            message.lowercased().contains("malformed") || message.lowercased().contains("type"),
            "empty-path typeMismatch should still be actionable, got: \(message)"
        )
    }

    /// Regression guard (#2986 AC2): `keyNotFound` must remain byte-for-byte
    /// `error.localizedDescription` even after typeMismatch/valueNotFound are mapped —
    /// `TypedRequestDecodeTests`' required-field contract depends on it.
    func testKeyNotFoundStaysUnchangedAfterTypeMismatchMapping() {
        let error = decodeError(#"{"type":"request_tap_coordinates","requestId":"kn-2","y":2}"#)
        guard case DecodingError.keyNotFound = error else {
            return XCTFail("expected keyNotFound, got \(error)")
        }
        let message = wireErrorMessage(for: error, requestId: "kn-2")
        XCTAssertEqual(
            message,
            error.localizedDescription,
            "keyNotFound must stay untouched by the typeMismatch/valueNotFound mapping"
        )
    }

    /// Regression guard (#2986 AC2): the `unknownCommand` wire contract still matches
    /// exactly after the new mapping — the TS `rewriteUnknownCommandError` relies on it.
    func testUnknownCommandStaysUnchangedAfterTypeMismatchMapping() {
        let error = decodeError(#"{"type":"unknown_command","requestId":"uc-2"}"#)
        let message = wireErrorMessage(for: error, requestId: "uc-2")
        XCTAssertEqual(message, "Unknown command type: unknown_command")
    }

    /// A wrong-typed *array element* (e.g. a bare string in `rules`, whose elements
    /// are objects) yields a `codingPath` whose deepest key is a synthetic array
    /// *index*, not a named field. The message attributes it to the nearest named
    /// ancestor with the index appended (`rules[0]`) rather than the useless
    /// "Index 0" key label. Uses the real `request_set_network_mock_rules` decode
    /// path (`rules: [NetworkMockRuleDTO]`).
    func testTypeMismatchOnArrayElementNamesParentWithIndex() {
        let error = decodeError(#"{"type":"set_network_mock_rules","requestId":"arr-1","rules":["hi"]}"#)
        guard case DecodingError.typeMismatch = error else {
            return XCTFail("expected typeMismatch on the array element, got \(error)")
        }
        let message = wireErrorMessage(for: error, requestId: "arr-1")
        XCTAssertTrue(
            message.contains("rules[0]"),
            "array-element typeMismatch should name the parent field with the index, got: \(message)"
        )
        XCTAssertFalse(
            message.contains("Index 0"),
            "message should not surface the synthetic 'Index 0' key label, got: \(message)"
        )
    }

    /// A synthetic `typeMismatch` whose leaf `codingPath` key is a bare array index
    /// (no named ancestor) falls back to `[<index>]` — pinned deterministically.
    func testTypeMismatchOnTopLevelArrayElementUsesBracketIndex() {
        let context = DecodingError.Context(
            codingPath: [TestCodingKey.index(2)],
            debugDescription: "Expected to decode Double but found a string instead."
        )
        let error = DecodingError.typeMismatch(Double.self, context)
        let message = wireErrorMessage(for: error, requestId: "arr-top")
        XCTAssertTrue(message.contains("[2]"), "got: \(message)")
        XCTAssertFalse(message.contains("Index"), "got: \(message)")
    }

    /// Coverage for the `dataCorrupted` **field-attribution fallback** (#2986): a
    /// *nested* `dataCorrupted` (non-empty `codingPath`, no underlying Cocoa detail)
    /// — unlike the empty-path top-level overflow case — names the field it occurred
    /// on instead of dropping it. Synthetic so it is host-independent and reaches the
    /// no-underlying-detail branch the overflow/malformed-JSON tests never hit.
    func testNestedDataCorruptedAttributesField() {
        let context = DecodingError.Context(
            codingPath: [TestCodingKey(stringValue: "y2")],
            debugDescription: "Date string does not match format expected by formatter."
        )
        let error = DecodingError.dataCorrupted(context)
        let message = wireErrorMessage(for: error, requestId: "dc-nested")
        XCTAssertTrue(
            message.contains("'y2'"),
            "nested dataCorrupted should attribute the field, got: \(message)"
        )
        XCTAssertNotEqual(message, error.localizedDescription, "got: \(message)")
    }

    // MARK: - Finite fractional / negative coordinates unaffected (#2909 happy path)

    /// Fractional coordinates decode and reach the engine with the fraction
    /// intact — the widening's whole point — and are not rejected by the guard.
    func testFractionalTapCoordinateIsPreserved() {
        let response = dispatch(
            #"{"type":"request_tap_coordinates","requestId":"tap-frac","x":100.5,"y":200.25}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.success, true)
        let history = fakeGesturePerformer.getTapHistory()
        XCTAssertEqual(history.first?.x ?? -1, 100.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.y ?? -1, 200.25, accuracy: 0.0001)
    }

    func testFractionalPinchCoordinatesArePreserved() {
        let response = dispatch(
            #"""
            {"type":"request_pinch","requestId":"pinch-frac","centerX":100.5,"centerY":200.5,"distanceStart":40.25,"distanceEnd":120.75}
            """#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.success, true)
        let history = fakeGesturePerformer.getPinchHistory()
        XCTAssertEqual(history.first?.centerX ?? -1, 100.5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.distanceEnd ?? -1, 120.75, accuracy: 0.0001)
    }

    /// Negative coordinates are finite and legitimate (off-screen anchors); the
    /// guard must not reject them.
    func testNegativeSwipeCoordinatesArePreserved() {
        let response = dispatch(
            #"{"type":"request_swipe","requestId":"swipe-neg","x1":-5,"y1":-10.5,"x2":30,"y2":40}"#,
            as: WebSocketResponse.self
        )
        XCTAssertEqual(response?.success, true)
        let history = fakeGesturePerformer.getSwipeHistory()
        XCTAssertEqual(history.first?.startX ?? .nan, -5, accuracy: 0.0001)
        XCTAssertEqual(history.first?.startY ?? .nan, -10.5, accuracy: 0.0001)
    }
}
