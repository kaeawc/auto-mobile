import AutoMobileSdkWire
@testable import CtrlProxy
import CtrlProxyTestSupport
import Foundation
import XCTest

/// Capture with AUTOMOBILE_FIXTURE_OUT_DIR; otherwise compare against the committed oracle.
final class ResponseContractFixtureTests: XCTestCase {
    func testRunnerResponseContract() throws {
        let requestId = "fixture-request-id"
        let timing = PerfTiming(name: "gesturePhases", durationMs: 7, children: [
            PerfTiming(name: "dispatch", durationMs: 3),
        ])
        let diagnostic = SdkStorageDiagnostic(code: "fixture", message: "fixture diagnostic")
        var responses: [[String: Any]] = []
        let encoder = JSONEncoder()
        // Same configuration and production Encodable path as WebSocketServer.encodeResponse.
        encoder.outputFormatting = .sortedKeys

        func append(_ name: String, _ response: any WebSocketResponsePayload) throws {
            let productionResponse: any WebSocketResponsePayload
            if var wsResponse = response as? WebSocketResponse, wsResponse.perfTiming == nil,
               name != "runner_busy"
            {
                wsResponse = wsResponse.withPerfTiming(timing, totalTimeMs: 17)
                productionResponse = wsResponse
            } else {
                productionResponse = response
            }
            let data = try productionResponse.encoded(with: encoder)
            var wire = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            // Most production initializers own Date(). Normalize ONLY an emitted timestamp value;
            // do not insert a missing field, so dropping timestamp still changes the oracle.
            if wire["timestamp"] != nil {
                XCTAssertNotNil(wire["timestamp"] as? NSNumber)
                wire["timestamp"] = Int64(1_700_000_000_000)
            }
            responses.append(["name": name, "wire": wire])
        }

        let genericTypes: [ResponseType] = [
            .tapCoordinatesResult, .swipeResult, .multiFingerSwipeResult, .dragResult, .pinchResult,
            .pathGestureResult,
            .setTextResult, .appendTextResult, .clearTextResult, .imeActionResult, .selectAllResult,
            .pressKeyResult, .pressButtonResult, .pressHomeResult, .pressBackResult, .recentAppsResult,
            .actionResult, .launchAppResult, .resetPermissionsResult, .highlightResponse,
            .setPreferenceResult, .removePreferenceResult, .clearPreferencesResult,
        ]
        for type in genericTypes {
            var response = WebSocketResponse(
                type: type.rawValue, timestamp: 1_700_000_000_000, requestId: requestId,
                success: true, totalTimeMs: 17, perfTiming: timing,
                verified: type == .pressKeyResult ? true : nil,
                warning: [.pressKeyResult, .actionResult].contains(type) ? "fixture warning" : nil,
                pinchPath: type == .pinchResult ? "event-path" : nil,
                resolvedStore: type == .setPreferenceResult ? "Standard" : nil,
                tapDiagnostics: type == .tapCoordinatesResult
                    ? TapDiagnostics(requested: .init(x: 12.5, y: 25.5, durationMs: 35)) : nil
            )
            if type == .setPreferenceResult { response.effectiveValueDiffers = true }
            try append(type.rawValue, response)
        }
        try append(
            "screenshot",
            ScreenshotResponse(requestId: requestId, data: "aW9z", rotation: 1, frameContext: "frame-42")
        )
        try append("hierarchy_update", HierarchyUpdateResponse(
            timestamp: 1_700_000_000_000, requestId: requestId,
            data: ViewHierarchy(
                updatedAt: 1_700_000_000_000,
                packageName: "fixture.app",
                screenWidth: 390,
                screenHeight: 844
            ),
            perfTiming: timing, frameContext: "frame-42", servedFromCache: true
        ))
        try append(
            "keyboard_result",
            KeyboardResponse(requestId: requestId, success: true, open: true, totalTimeMs: 17, method: "fixture")
        )
        try append("rotate_result", RotateResponse(requestId: requestId, success: true, totalTimeMs: 17,
                                                   previousOrientation: "portrait", currentOrientation: "landscape",
                                                   value: 1, rotationPerformed: true))
        try append(
            "hinge_angle_result",
            HingeAngleResponse(requestId: requestId, success: false, error: "unsupported", angle: 90, totalTimeMs: 17)
        )
        try append(
            "accessibility_audit_result",
            AccessibilityAuditResponse(
                requestId: requestId,
                issues: [AccessibilityAuditIssue(
                    check: "contrast", summary: "fixture issue", detail: "fixture detail",
                    elementId: "fixture-element", label: "Fixture",
                    bounds: ElementBounds(left: 1, top: 2, right: 3, bottom: 4)
                )],
                unsupportedChecks: ["fixture-check"],
                error: nil,
                totalTimeMs: 17
            )
        )
        try append(
            "magic_tap_result",
            MagicTapResponse(
                requestId: requestId,
                available: true,
                handled: false,
                error: "not handled",
                totalTimeMs: 17
            )
        )
        try append("sdk_trigger_result", SdkTriggerResponse(requestId: requestId, available: true,
                                                            reply: SdkTriggerReply(
                                                                statusCode: 404,
                                                                error: "unknown_trigger",
                                                                reason: "fixture",
                                                                registeredModules: ["callkit"],
                                                                supportedTriggers: ["incoming"]
                                                            ),
                                                            error: "fixture failure", totalTimeMs: 17))
        try append(
            "voiceover_state_result",
            VoiceOverStateResponse(requestId: requestId, enabled: true, totalTimeMs: 17)
        )
        try append(
            "voiceover_set_result",
            VoiceOverSetResponse(requestId: requestId, success: false, error: "fixture failure", totalTimeMs: 17)
        )
        try append("preference_files", StorageFilesResponse(requestId: requestId, success: true,
                                                            files: [StorageSuiteInfo(
                                                                name: "Standard",
                                                                path: "/fixture",
                                                                displayName: "Defaults",
                                                                entryCount: 2
                                                            )], totalTimeMs: 17))
        try append("preferences", StorageEntriesResponse(requestId: requestId, success: true,
                                                         entries: [StorageEntry(
                                                             key: "token",
                                                             value: "hidden",
                                                             type: "STRING",
                                                             redacted: true
                                                         )], totalTimeMs: 17))
        try append("get_preference_result", StorageEntryResponse(requestId: requestId, success: true, found: true,
                                                                 key: "token", value: "hidden", valueType: "STRING",
                                                                 totalTimeMs: 17, redacted: true))
        try append(
            "set_network_mock_rules_result",
            SetNetworkMockRulesResponse(
                requestId: requestId,
                ok: true,
                totalTimeMs: 17,
                rejectedMockIds: ["mock-42"],
                rejectedReasons: ["mock-42": "invalid pattern"]
            )
        )
        try append(
            "set_network_fault_rules_result",
            SetNetworkFaultRulesResponse(requestId: requestId, ok: true, totalTimeMs: 17)
        )
        try append(
            "set_network_error_simulation_result",
            SetNetworkErrorSimulationResponse(requestId: requestId, ok: true, totalTimeMs: 17)
        )
        try append(
            "sdk_capabilities_result",
            SdkCapabilitiesResponse(
                requestId: requestId,
                available: true,
                bundleId: "fixture.app",
                capabilities: ["hierarchy", "database"],
                totalTimeMs: 17
            )
        )
        try append(
            "execute_sql_result",
            ExecuteSqlResponse(
                requestId: requestId,
                success: true,
                queryType: "query",
                columns: ["id"],
                rows: [["42"], [nil]],
                rowsAffected: 2,
                diagnostic: diagnostic,
                truncated: true,
                totalTimeMs: 17
            )
        )
        try append("list_databases_result", ListDatabasesResponse(requestId: requestId, success: true,
                                                                  databases: [SdkDatabaseInfo(
                                                                      name: "app",
                                                                      path: "/app.sqlite",
                                                                      sizeBytes: 4096
                                                                  )], totalTimeMs: 17))
        try append("storage_capabilities_result", StorageCapabilitiesResponse(requestId: requestId, success: true,
                                                                              capabilities: SdkStorageCapabilities(
                                                                                  readOnly: false,
                                                                                  mutationAuthorized: true,
                                                                                  registeredAppGroupSuites: [
                                                                                      "group.fixture",
                                                                                  ],
                                                                                  coreDataStores: [],
                                                                                  unavailableStores: ["locked"]
                                                                              ), totalTimeMs: 17))
        try append(
            "list_tables_result",
            ListTablesResponse(requestId: requestId, success: true, tables: ["users"], totalTimeMs: 17)
        )
        try append(
            "table_data_result",
            TableDataResponse(
                requestId: requestId,
                success: true,
                columns: ["id"],
                rows: [["42"], [nil]],
                total: 2,
                diagnostic: diagnostic,
                totalTimeMs: 17
            )
        )
        try append("table_structure_result", TableStructureResponse(requestId: requestId, success: true,
                                                                    columns: [SdkColumnInfo(
                                                                        name: "id",
                                                                        type: "INTEGER",
                                                                        nullable: false,
                                                                        primaryKey: true,
                                                                        defaultValue: "0"
                                                                    )], diagnostic: diagnostic, totalTimeMs: 17))
        try append("current_focus_result", CurrentFocusResponse(requestId: requestId, totalTimeMs: 17))
        try append(
            "traversal_order_result",
            TraversalOrderResponse(requestId: requestId, focusedIndex: 0, totalTimeMs: 17)
        )
        // The production clipboard envelope carries text but has no action property (host defaults action to empty).
        try append("clipboard_result", WebSocketResponse(type: ResponseType.clipboardResult.rawValue,
                                                         timestamp: 1_700_000_000_000, requestId: requestId,
                                                         success: true, totalTimeMs: 17, text: "fixture text"))
        // The appearance envelope carries the read-back value in text (#14092).
        try append("appearance_result", WebSocketResponse(type: ResponseType.appearanceResult.rawValue,
                                                          timestamp: 1_700_000_000_000, requestId: requestId,
                                                          success: true, totalTimeMs: 17, text: "dark"))
        // The Siri envelope is a bare success/error acknowledgement (#14109).
        try append("siri_result", WebSocketResponse(type: ResponseType.siriResult.rawValue,
                                                    timestamp: 1_700_000_000_000, requestId: requestId,
                                                    success: true, totalTimeMs: 17))
        // The location envelope is a bare success/error acknowledgement (#14091).
        try append("location_result", WebSocketResponse(type: ResponseType.locationResult.rawValue,
                                                        timestamp: 1_700_000_000_000, requestId: requestId,
                                                        success: true, totalTimeMs: 17))

        let errors: [(String, CommandError)] = [
            (
                "deadline_completed_late",
                .deadlineExceeded(command: "request_swipe", deadlineMs: 5000, gestureCompleted: true)
            ),
            (
                "deadline_not_started",
                .deadlineExceeded(command: "request_swipe", deadlineMs: 5000, gestureCompleted: false)
            ),
            (
                "gesture_bound_exceeded",
                .gestureBoundExceeded(
                    command: "request_swipe",
                    phase: "xcuitestGesture",
                    boundMs: 4500,
                    elapsedMs: 4502
                )
            ),
            ("query_bound_exceeded", .queryBoundExceeded(command: "request_swipe", boundMs: 4500, elapsedMs: 4502)),
            ("hierarchy_capture_failed", .hierarchyCaptureFailed(reason: "fixture reason")),
            ("unknown_command", .unknownCommand("fixture_command")),
            ("missing_parameter", .missingParameter("fixture_parameter")),
            ("invalid_parameter", .invalidParameter("fixture_parameter", "fixture_value")),
            ("execution_failed", .executionFailed("fixture reason")),
        ]
        var commandErrors: [[String: Any]] = []
        for (name, error) in errors {
            commandErrors.append([
                "name": name,
                "error": error.localizedDescription,
                "errorCode": error.wireCode as Any? ?? NSNull(),
            ])
            try append("error_\(name)", WebSocketResponse(type: ResponseType.pressKeyResult.rawValue,
                                                          timestamp: 1_700_000_000_000, requestId: requestId,
                                                          success: false, totalTimeMs: 17,
                                                          error: error.localizedDescription, errorCode: error.wireCode))
        }
        try append("error_success_false_without_error", WebSocketResponse(
            type: ResponseType.pressKeyResult.rawValue, timestamp: 1_700_000_000_000,
            requestId: requestId, success: false, totalTimeMs: 17
        ))
        let focusError = GesturePerformer.GestureError.focusQueryFailed(
            phase: "fixture phase",
            detail: "fixture detail"
        )
        commandErrors.append([
            "name": "focus_query_failed",
            "error": focusError.localizedDescription,
            "errorCode": focusError.wireCode as Any? ?? NSNull(),
        ])
        try append("error_focus_query_failed", WebSocketResponse(type: ResponseType.pressKeyResult.rawValue,
                                                                 timestamp: 1_700_000_000_000, requestId: requestId,
                                                                 success: false, totalTimeMs: 17,
                                                                 error: focusError.localizedDescription,
                                                                 errorCode: focusError.wireCode))
        try append(
            "runner_busy",
            WebSocketResponse(
                type: "error",
                timestamp: 1_700_000_000_000,
                requestId: requestId,
                success: false,
                totalTimeMs: 17,
                error: "runner_busy",
                blockingCommandType: "request_activate_accessibility_link",
                blockingElapsedMs: 35000,
                blockingDeadlineRemainingMs: -5000
            )
        )
        try append(
            "delete_keychain_item_result",
            DeleteKeychainItemResponse(
                requestId: requestId,
                outcome: KeychainDeleteOutcome(
                    outcome: "deleted",
                    deletedScope: KeychainItemSelector(
                        itemClass: "genericPassword",
                        service: "test.service",
                        account: "fixture",
                        accessGroup: "TEAM.app"
                    )
                ),
                totalTimeMs: 17
            )
        )
        try append(
            "delete_keychain_item_denied",
            DeleteKeychainItemResponse(
                requestId: requestId,
                outcome: KeychainDeleteOutcome(outcome: "mutation_not_authorized"),
                totalTimeMs: 17
            )
        )
        let root: [String: Any] = [
            "responseTypes": ResponseType.allCases.map(\.rawValue).sorted(),
            "responses": responses,
            "commandErrors": commandErrors,
        ]
        let data = try JSONSerialization
            .data(withJSONObject: root, options: [.sortedKeys, .prettyPrinted]) + Data("\n".utf8)
        let committed = WireSnapshotFixture.fixtureURL(fromTestFilePath: #filePath)
            .deletingLastPathComponent().appendingPathComponent("ios-contract/runner-responses.json")
        if let directory = ProcessInfo.processInfo.environment["AUTOMOBILE_FIXTURE_OUT_DIR"] {
            let destination = URL(fileURLWithPath: directory).appendingPathComponent("runner-responses.json")
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: destination)
        } else {
            XCTAssertEqual(
                try Data(contentsOf: committed),
                data,
                "Runner encoders drifted; regenerate and review the shared fixture"
            )
        }
    }
}
