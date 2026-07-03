import Foundation

// MARK: - Request Models (typed per-command model — see issue #2846)

// The iOS control-proxy decodes each inbound WebSocket command into a typed
// `WebSocketRequest` case carrying a per-command payload that declares only the
// fields that command uses. This replaces the former flat ~43-optional bag +
// `switch request.type` dispatch (the iOS analog of the Android migration in
// #2752 / #2771). The wire format is unchanged: the same `type` discriminator
// strings (see `RequestType`) and the same JSON field names are decoded.
//
// Field policy: a payload field is a decode-required (non-optional) property
// only when the former handler threw `CommandError.missingParameter` on its
// absence (a generic error). Fields with handler-side defaults, and fields
// whose absence produced a *command-specific* typed error response
// (storage/database/highlight), stay optional and are validated in the handler.
//
// Payloads use `var` with `= nil` on optionals so they get both a synthesized
// `Decodable` (which decodes `var`-with-default) and a memberwise initializer
// with defaults for test construction.

// MARK: No-argument command envelope

/// Payload for commands that carry no parameters beyond the request id.
public struct RequestEnvelope: Decodable {
    public var requestId: String?
}

// MARK: View hierarchy

public struct RequestHierarchy: Decodable {
    public var requestId: String?
    public var disableAllFiltering: Bool?
    public var sinceTimestamp: Int64?
}

// MARK: Gestures

public struct RequestTapCoordinates: Decodable {
    public var requestId: String?
    public var x: Int
    public var y: Int
    public var duration: Int?
}

public struct RequestSwipe: Decodable {
    public var requestId: String?
    public var x1: Int
    public var y1: Int
    public var x2: Int
    public var y2: Int
    public var duration: Int?
}

public struct RequestMultiFingerSwipe: Decodable {
    public var requestId: String?
    public var x1: Int
    public var y1: Int
    public var x2: Int
    public var y2: Int
    public var fingerCount: Int?
    public var duration: Int?
    public var offset: Double?
}

public struct RequestDrag: Decodable {
    public var requestId: String?
    public var x1: Int
    public var y1: Int
    public var x2: Int
    public var y2: Int
    public var pressDurationMs: Int?
    public var dragDurationMs: Int?
    public var holdDurationMs: Int?
    public var holdTime: Int?
}

public struct RequestPinch: Decodable {
    public var requestId: String?
    public var centerX: Int
    public var centerY: Int
    public var distanceStart: Int
    public var distanceEnd: Int
    public var rotationDegrees: Float?
    public var duration: Int?
}

// MARK: Text input

public struct RequestSetText: Decodable {
    public var requestId: String?
    public var text: String
    public var resourceId: String?
}

public struct RequestClearText: Decodable {
    public var requestId: String?
    public var resourceId: String?
}

public struct RequestImeAction: Decodable {
    public var requestId: String?
    public var action: String
}

public struct RequestKeyboard: Decodable {
    public var requestId: String?
    public var action: String
}

public struct RequestPressButton: Decodable {
    public var requestId: String?
    public var action: String
}

// MARK: Actions

public struct RequestAction: Decodable {
    public var requestId: String?
    public var action: String
    public var resourceId: String?
    public var label: String?
}

public struct RequestLaunchApp: Decodable {
    public var requestId: String?
    public var bundleId: String
    public var coldBoot: Bool?
}

// MARK: Device control

public struct RequestRotate: Decodable {
    public var requestId: String?
    public var orientation: String
}

public struct RequestClipboard: Decodable {
    public var requestId: String?
    public var action: String
    public var text: String?
}

// MARK: Accessibility features

public struct RequestAddHighlight: Decodable {
    public var requestId: String?
    public var id: String?
    public var shape: HighlightShape?
}

// MARK: Storage inspection

public struct RequestGetPreferences: Decodable {
    public var requestId: String?
    public var fileName: String?
}

public struct RequestGetPreference: Decodable {
    public var requestId: String?
    public var key: String?
    public var fileName: String?
}

public struct RequestSetPreference: Decodable {
    public var requestId: String?
    public var key: String
    public var value: String?
    public var valueType: String
    public var fileName: String?
}

public struct RequestRemovePreference: Decodable {
    public var requestId: String?
    public var key: String
    public var fileName: String?
}

public struct RequestClearPreferences: Decodable {
    public var requestId: String?
    public var fileName: String?
}

// MARK: Network mocking

public struct RequestSetNetworkMockRules: Decodable {
    public var requestId: String?
    public var rules: [NetworkMockRuleDTO]
}

// MARK: Database inspection

public struct RequestExecuteSql: Decodable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var query: String?
}

public struct RequestListDatabases: Decodable {
    public var requestId: String?
    public var appId: String?
}

public struct RequestListTables: Decodable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
}

public struct RequestGetTableData: Decodable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var table: String?
    public var limit: Int?
    public var offset: Double?
}

public struct RequestGetTableStructure: Decodable {
    public var requestId: String?
    public var appId: String?
    public var databasePath: String?
    public var table: String?
}

// MARK: - Typed request envelope

/// Typed WebSocket request from the automation client. Each case carries only
/// the fields its command uses. Decoded from the flat JSON `{ "type": ... }`
/// envelope by reading the `type` discriminator and decoding the matching
/// payload from the same container.
public enum WebSocketRequest: Decodable {
    case requestHierarchy(RequestHierarchy)
    case requestHierarchyIfStale(RequestHierarchy)
    case requestScreenshot(RequestEnvelope)

    case tapCoordinates(RequestTapCoordinates)
    case swipe(RequestSwipe)
    case twoFingerSwipe(RequestMultiFingerSwipe)
    case multiFingerSwipe(RequestMultiFingerSwipe)
    case drag(RequestDrag)
    case pinch(RequestPinch)

    case setText(RequestSetText)
    case clearText(RequestClearText)
    case imeAction(RequestImeAction)
    case selectAll(RequestEnvelope)
    case keyboard(RequestKeyboard)
    case pressButton(RequestPressButton)
    case pressHome(RequestEnvelope)
    case pressBack(RequestEnvelope)
    case shake(RequestEnvelope)
    case recentApps(RequestEnvelope)

    case action(RequestAction)
    case launchApp(RequestLaunchApp)
    case rotate(RequestRotate)
    case clipboard(RequestClipboard)

    case getCurrentFocus(RequestEnvelope)
    case getTraversalOrder(RequestEnvelope)
    case addHighlight(RequestAddHighlight)
    case getVoiceOverState(RequestEnvelope)

    case listPreferenceFiles(RequestEnvelope)
    case getPreferences(RequestGetPreferences)
    case getPreference(RequestGetPreference)
    case setPreference(RequestSetPreference)
    case removePreference(RequestRemovePreference)
    case clearPreferences(RequestClearPreferences)

    case setNetworkMockRules(RequestSetNetworkMockRules)

    case executeSql(RequestExecuteSql)
    case listDatabases(RequestListDatabases)
    case listTables(RequestListTables)
    case getTableData(RequestGetTableData)
    case getTableStructure(RequestGetTableStructure)

    private enum DiscriminatorKey: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKey.self)
        let typeString = try container.decode(String.self, forKey: .type)
        guard let requestType = RequestType(rawValue: typeString) else {
            // Throw CommandError (a LocalizedError) rather than DecodingError so the
            // error surfaced on the wire is "Unknown command type: <type>". The TS
            // client's `rewriteUnknownCommandError` matches that exact text to warn
            // that the deployed runner is older than the daemon; a generic
            // DecodingError.localizedDescription would silently lose that diagnostic.
            throw CommandError.unknownCommand(typeString)
        }

        switch requestType {
        case .requestHierarchy:
            self = try .requestHierarchy(RequestHierarchy(from: decoder))
        case .requestHierarchyIfStale:
            self = try .requestHierarchyIfStale(RequestHierarchy(from: decoder))
        case .requestScreenshot:
            self = try .requestScreenshot(RequestEnvelope(from: decoder))
        case .requestTapCoordinates:
            self = try .tapCoordinates(RequestTapCoordinates(from: decoder))
        case .requestSwipe:
            self = try .swipe(RequestSwipe(from: decoder))
        case .requestTwoFingerSwipe:
            self = try .twoFingerSwipe(RequestMultiFingerSwipe(from: decoder))
        case .requestMultiFingerSwipe:
            self = try .multiFingerSwipe(RequestMultiFingerSwipe(from: decoder))
        case .requestDrag:
            self = try .drag(RequestDrag(from: decoder))
        case .requestPinch:
            self = try .pinch(RequestPinch(from: decoder))
        case .requestSetText:
            self = try .setText(RequestSetText(from: decoder))
        case .requestClearText:
            self = try .clearText(RequestClearText(from: decoder))
        case .requestImeAction:
            self = try .imeAction(RequestImeAction(from: decoder))
        case .requestSelectAll:
            self = try .selectAll(RequestEnvelope(from: decoder))
        case .requestKeyboard:
            self = try .keyboard(RequestKeyboard(from: decoder))
        case .requestPressButton:
            self = try .pressButton(RequestPressButton(from: decoder))
        case .requestPressHome:
            self = try .pressHome(RequestEnvelope(from: decoder))
        case .requestPressBack:
            self = try .pressBack(RequestEnvelope(from: decoder))
        case .requestShake:
            self = try .shake(RequestEnvelope(from: decoder))
        case .requestRecentApps:
            self = try .recentApps(RequestEnvelope(from: decoder))
        case .requestAction:
            self = try .action(RequestAction(from: decoder))
        case .requestLaunchApp:
            self = try .launchApp(RequestLaunchApp(from: decoder))
        case .requestRotate:
            self = try .rotate(RequestRotate(from: decoder))
        case .requestClipboard:
            self = try .clipboard(RequestClipboard(from: decoder))
        case .getCurrentFocus:
            self = try .getCurrentFocus(RequestEnvelope(from: decoder))
        case .getTraversalOrder:
            self = try .getTraversalOrder(RequestEnvelope(from: decoder))
        case .addHighlight:
            self = try .addHighlight(RequestAddHighlight(from: decoder))
        case .getVoiceOverState:
            self = try .getVoiceOverState(RequestEnvelope(from: decoder))
        case .listPreferenceFiles:
            self = try .listPreferenceFiles(RequestEnvelope(from: decoder))
        case .getPreferences:
            self = try .getPreferences(RequestGetPreferences(from: decoder))
        case .getPreference:
            self = try .getPreference(RequestGetPreference(from: decoder))
        case .setPreference:
            self = try .setPreference(RequestSetPreference(from: decoder))
        case .removePreference:
            self = try .removePreference(RequestRemovePreference(from: decoder))
        case .clearPreferences:
            self = try .clearPreferences(RequestClearPreferences(from: decoder))
        case .setNetworkMockRules:
            self = try .setNetworkMockRules(RequestSetNetworkMockRules(from: decoder))
        case .executeSql:
            self = try .executeSql(RequestExecuteSql(from: decoder))
        case .listDatabases:
            self = try .listDatabases(RequestListDatabases(from: decoder))
        case .listTables:
            self = try .listTables(RequestListTables(from: decoder))
        case .getTableData:
            self = try .getTableData(RequestGetTableData(from: decoder))
        case .getTableStructure:
            self = try .getTableStructure(RequestGetTableStructure(from: decoder))
        }
    }

    /// The wire discriminator for this command.
    public var requestType: RequestType {
        switch self {
        case .requestHierarchy: return .requestHierarchy
        case .requestHierarchyIfStale: return .requestHierarchyIfStale
        case .requestScreenshot: return .requestScreenshot
        case .tapCoordinates: return .requestTapCoordinates
        case .swipe: return .requestSwipe
        case .twoFingerSwipe: return .requestTwoFingerSwipe
        case .multiFingerSwipe: return .requestMultiFingerSwipe
        case .drag: return .requestDrag
        case .pinch: return .requestPinch
        case .setText: return .requestSetText
        case .clearText: return .requestClearText
        case .imeAction: return .requestImeAction
        case .selectAll: return .requestSelectAll
        case .keyboard: return .requestKeyboard
        case .pressButton: return .requestPressButton
        case .pressHome: return .requestPressHome
        case .pressBack: return .requestPressBack
        case .shake: return .requestShake
        case .recentApps: return .requestRecentApps
        case .action: return .requestAction
        case .launchApp: return .requestLaunchApp
        case .rotate: return .requestRotate
        case .clipboard: return .requestClipboard
        case .getCurrentFocus: return .getCurrentFocus
        case .getTraversalOrder: return .getTraversalOrder
        case .addHighlight: return .addHighlight
        case .getVoiceOverState: return .getVoiceOverState
        case .listPreferenceFiles: return .listPreferenceFiles
        case .getPreferences: return .getPreferences
        case .getPreference: return .getPreference
        case .setPreference: return .setPreference
        case .removePreference: return .removePreference
        case .clearPreferences: return .clearPreferences
        case .setNetworkMockRules: return .setNetworkMockRules
        case .executeSql: return .executeSql
        case .listDatabases: return .listDatabases
        case .listTables: return .listTables
        case .getTableData: return .getTableData
        case .getTableStructure: return .getTableStructure
        }
    }

    /// The wire discriminator string for this command.
    public var typeString: String {
        requestType.rawValue
    }

    /// The client-supplied correlation id, if any.
    public var requestId: String? {
        switch self {
        case let .requestHierarchy(payload), let .requestHierarchyIfStale(payload):
            return payload.requestId
        case let .requestScreenshot(payload),
             let .selectAll(payload),
             let .pressHome(payload),
             let .pressBack(payload),
             let .shake(payload),
             let .recentApps(payload),
             let .getCurrentFocus(payload),
             let .getTraversalOrder(payload),
             let .getVoiceOverState(payload),
             let .listPreferenceFiles(payload):
            return payload.requestId
        case let .tapCoordinates(payload): return payload.requestId
        case let .swipe(payload): return payload.requestId
        case let .twoFingerSwipe(payload), let .multiFingerSwipe(payload):
            return payload.requestId
        case let .drag(payload): return payload.requestId
        case let .pinch(payload): return payload.requestId
        case let .setText(payload): return payload.requestId
        case let .clearText(payload): return payload.requestId
        case let .imeAction(payload): return payload.requestId
        case let .keyboard(payload): return payload.requestId
        case let .pressButton(payload): return payload.requestId
        case let .action(payload): return payload.requestId
        case let .launchApp(payload): return payload.requestId
        case let .rotate(payload): return payload.requestId
        case let .clipboard(payload): return payload.requestId
        case let .addHighlight(payload): return payload.requestId
        case let .getPreferences(payload): return payload.requestId
        case let .getPreference(payload): return payload.requestId
        case let .setPreference(payload): return payload.requestId
        case let .removePreference(payload): return payload.requestId
        case let .clearPreferences(payload): return payload.requestId
        case let .setNetworkMockRules(payload): return payload.requestId
        case let .executeSql(payload): return payload.requestId
        case let .listDatabases(payload): return payload.requestId
        case let .listTables(payload): return payload.requestId
        case let .getTableData(payload): return payload.requestId
        case let .getTableStructure(payload): return payload.requestId
        }
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
        type = ResponseType.rotateResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
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
        type = ResponseType.keyboardResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
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
        type = ResponseType.preferenceFiles.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
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
        type = ResponseType.preferences.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
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
        type = ResponseType.getPreferenceResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
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

// MARK: - Database Response Models

public struct ExecuteSqlResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let queryType: String?
    public let columns: [String]?
    public let rows: [[String?]]?
    public let rowsAffected: Int?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        queryType: String? = nil,
        columns: [String]? = nil,
        rows: [[String?]]? = nil,
        rowsAffected: Int? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.executeSqlResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.queryType = queryType
        self.columns = columns
        self.rows = rows
        self.rowsAffected = rowsAffected
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

public struct ListDatabasesResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let databases: [SdkDatabaseInfo]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        databases: [SdkDatabaseInfo]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.listDatabasesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.databases = databases
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

public struct ListTablesResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let tables: [String]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        tables: [String]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.listTablesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.tables = tables
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

public struct TableDataResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let columns: [String]?
    public let rows: [[String?]]?
    public let total: Int?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        columns: [String]? = nil,
        rows: [[String?]]? = nil,
        total: Int? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.tableDataResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.columns = columns
        self.rows = rows
        self.total = total
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}

public struct TableStructureResponse: Codable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let columns: [SdkColumnInfo]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        columns: [SdkColumnInfo]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.tableStructureResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.columns = columns
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

    /// Device control
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

    /// Network mocking
    case setNetworkMockRules = "set_network_mock_rules"

    // Database inspection
    case executeSql = "execute_sql"
    case listDatabases = "list_databases"
    case listTables = "list_tables"
    case getTableData = "get_table_data"
    case getTableStructure = "get_table_structure"
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

    // Database inspection
    case executeSqlResult = "execute_sql_result"
    case listDatabasesResult = "list_databases_result"
    case listTablesResult = "list_tables_result"
    case tableDataResult = "table_data_result"
    case tableStructureResult = "table_structure_result"
}
