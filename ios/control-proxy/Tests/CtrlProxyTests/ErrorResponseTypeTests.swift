@testable import CtrlProxy
import XCTest

/// Locks the enum-derived `RequestType.responseType` mapping that replaces the
/// former stringly-typed `responseType(for:)` table with its `default:"error"`
/// fallback (issue #2859 part 2). The mapping is exhaustive (no `default`), so a
/// new `RequestType` case fails to compile until mapped — and every command,
/// including the three the old table silently dropped to `"error"`
/// (getCurrentFocus / getTraversalOrder / addHighlight), now resolves to its own
/// result type.
final class ErrorResponseTypeTests: XCTestCase {
    /// Every `RequestType` maps to the exact `ResponseType` its handler emits.
    func testResponseTypeMappingIsTotalAndCorrect() {
        let expected: [RequestType: ResponseType] = [
            .requestHierarchy: .hierarchyUpdate,
            .requestHierarchyIfStale: .hierarchyUpdate,
            .setHierarchyPollInterval: .setHierarchyPollIntervalResult,
            .requestScreenshot: .screenshot,
            .requestTapCoordinates: .tapCoordinatesResult,
            .requestSwipe: .swipeResult,
            .requestTwoFingerSwipe: .multiFingerSwipeResult,
            .requestMultiFingerSwipe: .multiFingerSwipeResult,
            .requestDrag: .dragResult,
            .requestPinch: .pinchResult,
            .requestSetText: .setTextResult,
            .requestAppendText: .appendTextResult,
            .requestClearText: .clearTextResult,
            .requestImeAction: .imeActionResult,
            .requestSelectAll: .selectAllResult,
            .requestKeyboard: .keyboardResult,
            .requestPressButton: .pressButtonResult,
            .requestPressHome: .pressHomeResult,
            .requestPressBack: .pressBackResult,
            .requestShake: .shakeResult,
            .requestRecentApps: .recentAppsResult,
            .requestAction: .actionResult,
            .requestLaunchApp: .launchAppResult,
            .requestResetPermissions: .resetPermissionsResult,
            .requestRotate: .rotateResult,
            .requestClipboard: .clipboardResult,
            .getCurrentFocus: .currentFocusResult,
            .getTraversalOrder: .traversalOrderResult,
            .addHighlight: .highlightResponse,
            .getVoiceOverState: .voiceOverStateResult,
            .listPreferenceFiles: .preferenceFiles,
            .getPreferences: .preferences,
            .getPreference: .getPreferenceResult,
            .setPreference: .setPreferenceResult,
            .removePreference: .removePreferenceResult,
            .clearPreferences: .clearPreferencesResult,
            .setNetworkMockRules: .setNetworkMockRulesResult,
            .setNetworkErrorSimulation: .setNetworkErrorSimulationResult,
            .executeSql: .executeSqlResult,
            .listDatabases: .listDatabasesResult,
            .storageCapabilities: .storageCapabilitiesResult,
            .listTables: .listTablesResult,
            .getTableData: .tableDataResult,
            .getTableStructure: .tableStructureResult,
        ]

        // Every case is covered by the fixture — guards against an untested new case.
        for requestType in RequestType.allCases {
            guard let want = expected[requestType] else {
                XCTFail("missing responseType fixture for \(requestType.rawValue)")
                continue
            }
            XCTAssertEqual(
                requestType.responseType,
                want,
                "\(requestType.rawValue) → \(requestType.responseType.rawValue), expected \(want.rawValue)"
            )
        }
    }

    /// The three commands the old `default:"error"` table dropped now resolve to a
    /// concrete result type rather than the opaque `"error"` string.
    func testFormerlyErrorFallbackCasesNowMapToResultType() {
        XCTAssertEqual(RequestType.getCurrentFocus.responseType.rawValue, "current_focus_result")
        XCTAssertEqual(RequestType.getTraversalOrder.responseType.rawValue, "traversal_order_result")
        XCTAssertEqual(RequestType.addHighlight.responseType.rawValue, "highlight_response")
        for requestType in [RequestType.getCurrentFocus, .getTraversalOrder, .addHighlight] {
            XCTAssertNotEqual(requestType.responseType.rawValue, "error", "\(requestType.rawValue)")
        }
    }

    /// The catch path in `CommandHandler.handle` tags a thrown error with the
    /// command's own result type (via the enum mapping), not `"error"`. A throwing
    /// hierarchy extraction surfaces a `hierarchy_update`-typed failure envelope.
    func testHandleCatchTagsErrorWithCommandResultType() {
        let fakeTimeProvider = FakeTimeProvider(initialTime: 1000)
        let perfProvider = PerfProvider.createForTesting(timeProvider: fakeTimeProvider)
        let fakeElementLocator = FakeElementLocator()
        fakeElementLocator.setShouldThrow(CommandError.executionFailed("boom"))
        let handler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: perfProvider
        )
        defer {
            perfProvider.clear()
            PerfProvider.resetInstance()
        }

        let response = handler.handle(
            .requestHierarchy(RequestHierarchy(requestId: "err-1"))
        ) as? WebSocketResponse
        XCTAssertEqual(response?.type, "hierarchy_update")
        XCTAssertEqual(response?.success, false)
        XCTAssertEqual(response?.requestId, "err-1")
    }
}
