import Foundation

// MARK: - Request Types (matching Android)

public enum RequestType: String, CaseIterable, Sendable {
    // View hierarchy
    case requestHierarchy = "request_hierarchy"
    case requestHierarchyIfStale = "request_hierarchy_if_stale"
    case setHierarchyPollInterval = "set_hierarchy_poll_interval"
    case requestScreenshot = "request_screenshot"

    // Gestures
    case requestTapCoordinates = "request_tap_coordinates"
    case requestSwipe = "request_swipe"
    case requestTwoFingerSwipe = "request_two_finger_swipe"
    case requestMultiFingerSwipe = "request_multi_finger_swipe"
    case requestDrag = "request_drag"
    case requestPinch = "request_pinch"

    // Text input
    case requestSetText = "request_set_text"
    case requestAppendText = "request_append_text"
    case requestClearText = "request_clear_text"
    case requestImeAction = "request_ime_action"
    case requestSelectAll = "request_select_all"
    case requestKeyboard = "request_keyboard"
    case requestPressButton = "request_press_button"
    case requestPressHome = "request_press_home"
    case requestPressBack = "request_press_back"
    case requestShake = "request_shake"
    case requestRecentApps = "request_recent_apps"

    // Node actions
    case requestAction = "request_action"
    case requestActivateAccessibilityLink = "request_activate_accessibility_link"
    case requestLaunchApp = "request_launch_app"

    /// App privacy permissions
    case requestResetPermissions = "request_reset_permissions"

    /// Device control
    case requestRotate = "request_rotate"

    /// Clipboard
    case requestClipboard = "request_clipboard"

    // Accessibility features
    case getCurrentFocus = "get_current_focus"
    case getTraversalOrder = "get_traversal_order"
    case addHighlight = "add_highlight"
    case getVoiceOverState = "get_voiceover_state"
    case setVoiceOverState = "set_voiceover_state"

    // Storage inspection
    case listPreferenceFiles = "list_preference_files"
    case getPreferences = "get_preferences"
    case getPreference = "get_preference"
    case setPreference = "set_preference"
    case removePreference = "remove_preference"
    case clearPreferences = "clear_preferences"

    /// Network mocking
    case setNetworkMockRules = "set_network_mock_rules"
    case setNetworkFaultRules = "set_network_fault_rules"
    case setNetworkErrorSimulation = "set_network_error_simulation"

    // Database inspection
    case executeSql = "execute_sql"
    case listDatabases = "list_databases"
    case storageCapabilities = "storage_capabilities"
    case listTables = "list_tables"
    case getTableData = "get_table_data"
    case getTableStructure = "get_table_structure"
}

// MARK: - Request → Response type mapping

extension RequestType {
    /// The `ResponseType` this command's result carries — including on the error
    /// path. Exhaustive `switch` with no `default` (issue #2859 part 2): adding a
    /// `RequestType` case fails to compile until it is mapped here.
    public var responseType: ResponseType {
        switch self {
        case .requestHierarchy, .requestHierarchyIfStale: return .hierarchyUpdate
        case .setHierarchyPollInterval: return .setHierarchyPollIntervalResult
        case .requestScreenshot: return .screenshot
        case .requestTapCoordinates: return .tapCoordinatesResult
        case .requestSwipe: return .swipeResult
        case .requestTwoFingerSwipe, .requestMultiFingerSwipe: return .multiFingerSwipeResult
        case .requestDrag: return .dragResult
        case .requestPinch: return .pinchResult
        case .requestSetText: return .setTextResult
        case .requestAppendText: return .appendTextResult
        case .requestClearText: return .clearTextResult
        case .requestImeAction: return .imeActionResult
        case .requestSelectAll: return .selectAllResult
        case .requestKeyboard: return .keyboardResult
        case .requestPressButton: return .pressButtonResult
        case .requestPressHome: return .pressHomeResult
        case .requestPressBack: return .pressBackResult
        case .requestShake: return .shakeResult
        case .requestRecentApps: return .recentAppsResult
        case .requestAction: return .actionResult
        case .requestActivateAccessibilityLink: return .actionResult
        case .requestLaunchApp: return .launchAppResult
        case .requestResetPermissions: return .resetPermissionsResult
        case .requestRotate: return .rotateResult
        case .requestClipboard: return .clipboardResult
        case .getCurrentFocus: return .currentFocusResult
        case .getTraversalOrder: return .traversalOrderResult
        case .addHighlight: return .highlightResponse
        case .getVoiceOverState: return .voiceOverStateResult
        case .setVoiceOverState: return .voiceOverSetResult
        case .listPreferenceFiles: return .preferenceFiles
        case .getPreferences: return .preferences
        case .getPreference: return .getPreferenceResult
        case .setPreference: return .setPreferenceResult
        case .removePreference: return .removePreferenceResult
        case .clearPreferences: return .clearPreferencesResult
        case .setNetworkMockRules: return .setNetworkMockRulesResult
        case .setNetworkFaultRules: return .setNetworkFaultRulesResult
        case .setNetworkErrorSimulation: return .setNetworkErrorSimulationResult
        case .executeSql: return .executeSqlResult
        case .listDatabases: return .listDatabasesResult
        case .storageCapabilities: return .storageCapabilitiesResult
        case .listTables: return .listTablesResult
        case .getTableData: return .tableDataResult
        case .getTableStructure: return .tableStructureResult
        }
    }
}
