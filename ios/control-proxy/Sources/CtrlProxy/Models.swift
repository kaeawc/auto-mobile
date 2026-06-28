import Foundation

// MARK: - Request Models (matching Android AccessibilityService)

/// WebSocket request from automation client
/// Matches Android's WebSocketRequest format
public struct WebSocketRequest: Codable {
    public let type: String
    public let requestId: String?

    // Tap parameters
    public let x: Int?
    public let y: Int?
    public let duration: Int?

    // Swipe parameters
    public let x1: Int?
    public let y1: Int?
    public let x2: Int?
    public let y2: Int?
    public let offset: Int?
    public let fingerCount: Int?

    // Drag parameters
    public let pressDurationMs: Int?
    public let dragDurationMs: Int?
    public let holdDurationMs: Int?
    public let holdTime: Int?

    // Pinch parameters
    public let centerX: Int?
    public let centerY: Int?
    public let distanceStart: Int?
    public let distanceEnd: Int?
    public let rotationDegrees: Float?

    // Text input parameters
    public let text: String?
    public let resourceId: String?
    public let label: String?

    // Action parameters
    public let action: String?
    public let bundleId: String?

    // Filtering control
    public let sinceTimestamp: Int64?
    public let disableAllFiltering: Bool?

    // Highlight parameters
    public let id: String?
    public let shape: HighlightShape?

    // Storage parameters
    public let fileName: String?
    public let key: String?
    public let value: String?
    public let valueType: String?

    // App launch parameters
    public let coldBoot: Bool?

    // Rotation parameters
    public let orientation: String?

    // Permission/settings
    public let permission: String?
    public let requestPermission: Bool?
    public let enabled: Bool?

    // Network mocking
    public let rules: [NetworkMockRuleDTO]?

    public init(
        type: String,
        requestId: String? = nil,
        x: Int? = nil,
        y: Int? = nil,
        duration: Int? = nil,
        x1: Int? = nil,
        y1: Int? = nil,
        x2: Int? = nil,
        y2: Int? = nil,
        offset: Int? = nil,
        fingerCount: Int? = nil,
        pressDurationMs: Int? = nil,
        dragDurationMs: Int? = nil,
        holdDurationMs: Int? = nil,
        holdTime: Int? = nil,
        centerX: Int? = nil,
        centerY: Int? = nil,
        distanceStart: Int? = nil,
        distanceEnd: Int? = nil,
        rotationDegrees: Float? = nil,
        text: String? = nil,
        resourceId: String? = nil,
        label: String? = nil,
        action: String? = nil,
        bundleId: String? = nil,
        sinceTimestamp: Int64? = nil,
        disableAllFiltering: Bool? = nil,
        id: String? = nil,
        shape: HighlightShape? = nil,
        fileName: String? = nil,
        key: String? = nil,
        value: String? = nil,
        valueType: String? = nil,
        coldBoot: Bool? = nil,
        orientation: String? = nil,
        permission: String? = nil,
        requestPermission: Bool? = nil,
        enabled: Bool? = nil,
        networkMockRules: [NetworkMockRuleDTO]? = nil
    ) {
        self.type = type
        self.requestId = requestId
        self.x = x
        self.y = y
        self.duration = duration
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
        self.offset = offset
        self.fingerCount = fingerCount
        self.pressDurationMs = pressDurationMs
        self.dragDurationMs = dragDurationMs
        self.holdDurationMs = holdDurationMs
        self.holdTime = holdTime
        self.centerX = centerX
        self.centerY = centerY
        self.distanceStart = distanceStart
        self.distanceEnd = distanceEnd
        self.rotationDegrees = rotationDegrees
        self.text = text
        self.resourceId = resourceId
        self.label = label
        self.action = action
        self.bundleId = bundleId
        self.sinceTimestamp = sinceTimestamp
        self.disableAllFiltering = disableAllFiltering
        self.id = id
        self.shape = shape
        self.fileName = fileName
        self.key = key
        self.value = value
        self.valueType = valueType
        self.coldBoot = coldBoot
        self.orientation = orientation
        self.permission = permission
        self.requestPermission = requestPermission
        self.enabled = enabled
        self.rules = networkMockRules
    }
}

public struct NetworkMockRuleDTO: Codable, Sendable, Equatable {
    public let mockId: String
    public let host: String
    public let path: String
    public let method: String
    public let limit: Int?
    public let remaining: Int?
    public let statusCode: Int
    public let responseHeaders: [String: String]
    public let responseBody: String
    public let contentType: String

    public init(
        mockId: String,
        host: String,
        path: String,
        method: String,
        limit: Int?,
        remaining: Int?,
        statusCode: Int,
        responseHeaders: [String: String],
        responseBody: String,
        contentType: String
    ) {
        self.mockId = mockId
        self.host = host
        self.path = path
        self.method = method
        self.limit = limit
        self.remaining = remaining
        self.statusCode = statusCode
        self.responseHeaders = responseHeaders
        self.responseBody = responseBody
        self.contentType = contentType
    }
}

// MARK: - Response Models (matching Android AccessibilityService)

/// Base response structure
public struct WebSocketResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool?
    public let totalTimeMs: Int64?
    public let error: String?
    public let text: String?
    public let perfTiming: PerfTiming?

    public init(
        type: String,
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        requestId: String? = nil,
        success: Bool? = nil,
        totalTimeMs: Int64? = nil,
        error: String? = nil,
        text: String? = nil,
        perfTiming: PerfTiming? = nil
    ) {
        self.type = type
        self.timestamp = timestamp
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
        self.error = error
        self.text = text
        self.perfTiming = perfTiming
    }

    public static func success(
        type: String,
        requestId: String?,
        totalTimeMs: Int64,
        text: String? = nil
    )
        -> WebSocketResponse
    {
        WebSocketResponse(
            type: type,
            requestId: requestId,
            success: true,
            totalTimeMs: totalTimeMs,
            text: text
        )
    }

    public static func error(
        type: String,
        requestId: String?,
        error: String,
        totalTimeMs: Int64? = nil
    )
        -> WebSocketResponse
    {
        WebSocketResponse(
            type: type,
            requestId: requestId,
            success: false,
            totalTimeMs: totalTimeMs,
            error: error
        )
    }
}

public struct SetNetworkMockRulesResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let ok: Bool
    public let totalTimeMs: Int64?

    public init(requestId: String?, ok: Bool, totalTimeMs: Int64?) {
        type = ResponseType.setNetworkMockRulesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.ok = ok
        self.totalTimeMs = totalTimeMs
    }
}

/// Response for rotate commands with orientation details
public struct RotateResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let totalTimeMs: Int64
    public let previousOrientation: String
    public let currentOrientation: String
    public let value: Int
    public let rotationPerformed: Bool
    public let error: String?

    public init(
        requestId: String?,
        success: Bool,
        totalTimeMs: Int64,
        previousOrientation: String,
        currentOrientation: String,
        value: Int,
        rotationPerformed: Bool,
        error: String? = nil
    ) {
        self.type = ResponseType.rotateResult.rawValue
        self.timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.totalTimeMs = totalTimeMs
        self.previousOrientation = previousOrientation
        self.currentOrientation = currentOrientation
        self.value = value
        self.rotationPerformed = rotationPerformed
        self.error = error
    }
}

/// Response for keyboard commands with visibility state after the command.
public struct KeyboardResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let open: Bool
    public let totalTimeMs: Int64
    public let error: String?

    public init(
        requestId: String?,
        success: Bool,
        open: Bool,
        totalTimeMs: Int64,
        error: String? = nil
    ) {
        self.type = ResponseType.keyboardResult.rawValue
        self.timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.open = open
        self.totalTimeMs = totalTimeMs
        self.error = error
    }
}

/// Performance timing data - hierarchical format matching Android/TypeScript
public struct PerfTiming: Codable {
    public let name: String
    public let durationMs: Int64
    public let children: [PerfTiming]?

    public init(name: String, durationMs: Int64, children: [PerfTiming]? = nil) {
        self.name = name
        self.durationMs = durationMs
        self.children = children
    }

    /// Convenience for creating a simple timing with no children
    public static func timing(_ name: String, durationMs: Int64) -> PerfTiming {
        PerfTiming(name: name, durationMs: durationMs, children: nil)
    }

    /// Convenience for creating a timing with children
    public static func timing(_ name: String, durationMs: Int64, children: [PerfTiming]) -> PerfTiming {
        PerfTiming(name: name, durationMs: durationMs, children: children.isEmpty ? nil : children)
    }
}

// MARK: - Hierarchy Response

public struct HierarchyUpdateResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let data: ViewHierarchy?
    public let perfTiming: PerfTiming?
    public let error: String?

    public init(
        requestId: String? = nil,
        data: ViewHierarchy? = nil,
        perfTiming: PerfTiming? = nil,
        error: String? = nil
    ) {
        type = "hierarchy_update"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.data = data
        self.perfTiming = perfTiming
        self.error = error
    }
}

/// View hierarchy structure (matching Android's ViewHierarchy)
public struct ViewHierarchy: Codable {
    public let updatedAt: Int64
    public let packageName: String?
    public let hierarchy: UIElementInfo?
    public let windowInfo: WindowInfo?
    public let windows: [WindowInfo]?
    public let screenScale: Float?
    public let screenWidth: Int?
    public let screenHeight: Int?
    public let error: String?
    public let fallbackToSpringboard: Bool?

    public init(
        updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        packageName: String? = nil,
        hierarchy: UIElementInfo? = nil,
        windowInfo: WindowInfo? = nil,
        windows: [WindowInfo]? = nil,
        screenScale: Float? = nil,
        screenWidth: Int? = nil,
        screenHeight: Int? = nil,
        error: String? = nil,
        fallbackToSpringboard: Bool? = nil
    ) {
        self.updatedAt = updatedAt
        self.packageName = packageName
        self.hierarchy = hierarchy
        self.windowInfo = windowInfo
        self.windows = windows
        self.screenScale = screenScale
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.error = error
        self.fallbackToSpringboard = fallbackToSpringboard
    }
}

/// Window information
public struct WindowInfo: Codable {
    public let id: Int?
    public let type: Int?
    public let isActive: Bool
    public let isFocused: Bool
    public let bounds: ElementBounds?

    public init(
        id: Int? = nil,
        type: Int? = nil,
        isActive: Bool = false,
        isFocused: Bool = false,
        bounds: ElementBounds? = nil
    ) {
        self.id = id
        self.type = type
        self.isActive = isActive
        self.isFocused = isFocused
        self.bounds = bounds
    }
}

// MARK: - Element Models (matching Android's UIElementInfo)

/// UI Element information (matching Android's UIElementInfo)
public struct UIElementInfo: Codable {
    public let text: String?
    public let value: String?
    public let textSize: Float?
    public let contentDesc: String?
    public let resourceId: String?
    public let className: String?
    public let bounds: ElementBounds?
    public let clickable: String?
    public let enabled: String?
    public let focusable: String?
    public let focused: String?
    public let accessibilityFocused: String?
    public let scrollable: String?
    public let password: String?
    public let checkable: String?
    public let checked: String?
    public let selected: String?
    public let longClickable: String?
    public let testTag: String?
    public let role: String?
    public let stateDescription: String?
    public let errorMessage: String?
    public let hintText: String?
    public let viewId: String?
    public let extras: [String: String]?
    public let actions: [String]?
    public let node: [UIElementInfo]?

    enum CodingKeys: String, CodingKey {
        case text, value, textSize, className, bounds, clickable, enabled
        case focusable, focused, scrollable, password, checkable, checked
        case selected, actions, node, role, testTag, extras
        case viewId = "view-id"
        case contentDesc = "content-desc"
        case resourceId = "resource-id"
        case accessibilityFocused = "accessibility-focused"
        case longClickable = "long-clickable"
        case stateDescription = "state-description"
        case errorMessage = "error-message"
        case hintText = "hint-text"
    }

    public init(
        text: String? = nil,
        value: String? = nil,
        textSize: Float? = nil,
        contentDesc: String? = nil,
        resourceId: String? = nil,
        className: String? = nil,
        bounds: ElementBounds? = nil,
        clickable: String? = nil,
        enabled: String? = nil,
        focusable: String? = nil,
        focused: String? = nil,
        accessibilityFocused: String? = nil,
        scrollable: String? = nil,
        password: String? = nil,
        checkable: String? = nil,
        checked: String? = nil,
        selected: String? = nil,
        longClickable: String? = nil,
        testTag: String? = nil,
        role: String? = nil,
        stateDescription: String? = nil,
        errorMessage: String? = nil,
        hintText: String? = nil,
        viewId: String? = nil,
        extras: [String: String]? = nil,
        actions: [String]? = nil,
        node: [UIElementInfo]? = nil
    ) {
        self.text = text
        self.value = value
        self.textSize = textSize
        self.contentDesc = contentDesc
        self.resourceId = resourceId
        self.className = className
        self.bounds = bounds
        self.clickable = clickable
        self.enabled = enabled
        self.focusable = focusable
        self.focused = focused
        self.accessibilityFocused = accessibilityFocused
        self.scrollable = scrollable
        self.password = password
        self.checkable = checkable
        self.checked = checked
        self.selected = selected
        self.longClickable = longClickable
        self.testTag = testTag
        self.role = role
        self.stateDescription = stateDescription
        self.errorMessage = errorMessage
        self.hintText = hintText
        self.viewId = viewId
        self.extras = extras
        self.actions = actions
        self.node = node
    }
}

/// Element bounds (matching Android's ElementBounds)
public struct ElementBounds: Codable {
    public let left: Int
    public let top: Int
    public let right: Int
    public let bottom: Int

    public init(left: Int, top: Int, right: Int, bottom: Int) {
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom
    }

    public var width: Int {
        right - left
    }

    public var height: Int {
        bottom - top
    }

    public var centerX: Int {
        left + width / 2
    }

    public var centerY: Int {
        top + height / 2
    }
}

// MARK: - Screenshot Response

public struct ScreenshotResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let format: String
    public let data: String // Base64 encoded

    public init(requestId: String?, data: String, format: String = "png") {
        type = "screenshot"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.format = format
        self.data = data
    }
}

// MARK: - Highlight Models

public struct HighlightShape: Codable {
    public let type: String // "box" or "path"
    public let bounds: HighlightBounds?
    public let points: [HighlightPoint]?
    public let style: HighlightStyle?

    public init(
        type: String,
        bounds: HighlightBounds? = nil,
        points: [HighlightPoint]? = nil,
        style: HighlightStyle? = nil
    ) {
        self.type = type
        self.bounds = bounds
        self.points = points
        self.style = style
    }
}

public struct HighlightBounds: Codable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int
    public let sourceWidth: Int?
    public let sourceHeight: Int?

    public init(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        sourceWidth: Int? = nil,
        sourceHeight: Int? = nil
    ) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
    }
}

public struct HighlightPoint: Codable {
    public let x: Float
    public let y: Float

    public init(x: Float, y: Float) {
        self.x = x
        self.y = y
    }
}

public struct HighlightStyle: Codable {
    public let strokeColor: String?
    public let strokeWidth: Float?
    public let dashPattern: [Float]?
    public let smoothing: String?
    public let tension: Float?
    public let capStyle: String?
    public let joinStyle: String?

    public init(
        strokeColor: String? = nil,
        strokeWidth: Float? = nil,
        dashPattern: [Float]? = nil,
        smoothing: String? = nil,
        tension: Float? = nil,
        capStyle: String? = nil,
        joinStyle: String? = nil
    ) {
        self.strokeColor = strokeColor
        self.strokeWidth = strokeWidth
        self.dashPattern = dashPattern
        self.smoothing = smoothing
        self.tension = tension
        self.capStyle = capStyle
        self.joinStyle = joinStyle
    }
}

// MARK: - Storage Models

/// Information about a storage suite (UserDefaults suite)
public struct StorageSuiteInfo: Codable {
    public let name: String
    public let path: String
    public let displayName: String
    public let entryCount: Int

    public init(name: String, path: String? = nil, displayName: String, entryCount: Int) {
        self.name = name
        self.path = path ?? name
        self.displayName = displayName
        self.entryCount = entryCount
    }
}

/// A single key-value storage entry
public struct StorageEntry: Codable {
    public let key: String
    public let value: String?
    public let type: String

    public init(key: String, value: String?, type: String) {
        self.key = key
        self.value = value
        self.type = type
    }
}

// MARK: - Storage Response Models

/// Response for list_preference_files
public struct StorageFilesResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let files: [StorageSuiteInfo]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        files: [StorageSuiteInfo]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        self.type = ResponseType.preferenceFiles.rawValue
        self.timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.files = files
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

/// Response for get_preferences
public struct StorageEntriesResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let entries: [StorageEntry]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        entries: [StorageEntry]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        self.type = ResponseType.preferences.rawValue
        self.timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.entries = entries
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

/// Response for get_preference
public struct StorageEntryResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let found: Bool
    public let key: String?
    public let value: String?
    public let valueType: String?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        found: Bool,
        key: String? = nil,
        value: String? = nil,
        valueType: String? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        self.type = ResponseType.getPreferenceResult.rawValue
        self.timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.found = found
        self.key = key
        self.value = value
        self.valueType = valueType
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

// MARK: - Performance Update Response

/// Push notification for performance metrics (FPS, frame time, etc.)
public struct PerformanceUpdateResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let performanceData: PerformanceSnapshot

    public init(data: PerformanceSnapshot) {
        type = "performance_update"
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        performanceData = data
    }
}

// MARK: - Connected Event

public struct ConnectedEvent: Codable {
    public let type: String
    public let id: Int
    public let supportedCommands: [String]

    public init(id: Int) {
        type = "connected"
        self.id = id
        supportedCommands = RequestType.allCases.map(\.rawValue).sorted()
    }
}

// MARK: - VoiceOver State Response

/// Response to get_voiceover_state command
public struct VoiceOverStateResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let enabled: Bool
    public let totalTimeMs: Int64?

    public init(requestId: String?, enabled: Bool, totalTimeMs: Int64?) {
        type = ResponseType.voiceOverStateResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        success = true
        self.enabled = enabled
        self.totalTimeMs = totalTimeMs
    }
}

// MARK: - Request Types (matching Android)

public enum RequestType: String, CaseIterable {
    // View hierarchy
    case requestHierarchy = "request_hierarchy"
    case requestHierarchyIfStale = "request_hierarchy_if_stale"
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
    case requestLaunchApp = "request_launch_app"

    // Device control
    case requestRotate = "request_rotate"

    /// Clipboard
    case requestClipboard = "request_clipboard"

    // Accessibility features
    case getCurrentFocus = "get_current_focus"
    case getTraversalOrder = "get_traversal_order"
    case addHighlight = "add_highlight"
    case getVoiceOverState = "get_voiceover_state"

    // Storage inspection
    case listPreferenceFiles = "list_preference_files"
    case getPreferences = "get_preferences"
    case getPreference = "get_preference"
    case setPreference = "set_preference"
    case removePreference = "remove_preference"
    case clearPreferences = "clear_preferences"

    // Network mocking
    case setNetworkMockRules = "set_network_mock_rules"
}

// MARK: - Response Types (matching Android)

public enum ResponseType: String {
    case hierarchyUpdate = "hierarchy_update"
    case screenshot
    case screenshotError = "screenshot_error"
    case tapCoordinatesResult = "tap_coordinates_result"
    case swipeResult = "swipe_result"
    case multiFingerSwipeResult = "multi_finger_swipe_result"
    case dragResult = "drag_result"
    case pinchResult = "pinch_result"
    case setTextResult = "set_text_result"
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
    case rotateResult = "rotate_result"
    case clipboardResult = "clipboard_result"
    case currentFocusResult = "current_focus_result"
    case traversalOrderResult = "traversal_order_result"
    case highlightResponse = "highlight_response"
    case voiceOverStateResult = "voiceover_state_result"
    case connected

    // Storage inspection
    case preferenceFiles = "preference_files"
    case preferences
    case getPreferenceResult = "get_preference_result"
    case setPreferenceResult = "set_preference_result"
    case removePreferenceResult = "remove_preference_result"
    case clearPreferencesResult = "clear_preferences_result"
    case setNetworkMockRulesResult = "set_network_mock_rules_result"
}
