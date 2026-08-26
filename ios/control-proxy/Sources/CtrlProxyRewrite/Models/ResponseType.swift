import Foundation

// MARK: - Response Types (matching Android)

public enum ResponseType: String, Sendable {
    case hierarchyUpdate = "hierarchy_update"
    case setHierarchyPollIntervalResult = "set_hierarchy_poll_interval_result"
    case screenshot
    case screenshotError = "screenshot_error"
    case tapCoordinatesResult = "tap_coordinates_result"
    case swipeResult = "swipe_result"
    case multiFingerSwipeResult = "multi_finger_swipe_result"
    case dragResult = "drag_result"
    case pinchResult = "pinch_result"
    case setTextResult = "set_text_result"
    case appendTextResult = "append_text_result"
    case clearTextResult = "clear_text_result"
    case imeActionResult = "ime_action_result"
    case selectAllResult = "select_all_result"
    case keyboardResult = "keyboard_result"
    case pressButtonResult = "press_button_result"
    case pressHomeResult = "press_home_result"
    case pressBackResult = "press_back_result"
    case shakeResult = "shake_result"
    case recentAppsResult = "recent_apps_result"
    case actionResult = "action_result"
    case launchAppResult = "launch_app_result"
    case resetPermissionsResult = "reset_permissions_result"
    case rotateResult = "rotate_result"
    case clipboardResult = "clipboard_result"
    case currentFocusResult = "current_focus_result"
    case traversalOrderResult = "traversal_order_result"
    case highlightResponse = "highlight_response"
    case voiceOverStateResult = "voiceover_state_result"
    case voiceOverSetResult = "voiceover_set_result"
    case connected

    // Storage inspection
    case preferenceFiles = "preference_files"
    case preferences
    case getPreferenceResult = "get_preference_result"
    case setPreferenceResult = "set_preference_result"
    case removePreferenceResult = "remove_preference_result"
    case clearPreferencesResult = "clear_preferences_result"
    case setNetworkMockRulesResult = "set_network_mock_rules_result"
    case setNetworkFaultRulesResult = "set_network_fault_rules_result"
    case setNetworkErrorSimulationResult = "set_network_error_simulation_result"

    // Database inspection
    case executeSqlResult = "execute_sql_result"
    case listDatabasesResult = "list_databases_result"
    case storageCapabilitiesResult = "storage_capabilities_result"
    case listTablesResult = "list_tables_result"
    case tableDataResult = "table_data_result"
    case tableStructureResult = "table_structure_result"
}
