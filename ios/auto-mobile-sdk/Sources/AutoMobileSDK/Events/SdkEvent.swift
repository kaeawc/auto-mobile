import Foundation

/// Base protocol for all SDK events sent from the AutoMobile SDK.
public protocol SdkEvent: Codable, Sendable {
    var eventType: SdkEventType { get }
    /// Milliseconds since epoch (matches Android SDK wire format).
    var timestamp: Int64 { get }
}

/// Discriminator for SDK event types.
public enum SdkEventType: String, Codable, Sendable {
    case navigation
    case handledException = "handled_exception"
    case crash
    case hang
    case networkRequest = "network_request"
    case webSocketFrame = "websocket_frame"
    case log
    case lifecycle
    case notificationAction = "notification_action"
    case viewBodySnapshot = "view_body_snapshot"
    case broadcast
    case interaction
    case storageChanged = "storage_changed"
    case viewHierarchy = "view_hierarchy"
    case webView = "webview"
}

// MARK: - Event Types

/// A navigation event recording an in-app screen transition.
public struct SdkNavigationEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .navigation
    public let timestamp: Int64
    /// Monotonic per-SDK navigation order used to break same-millisecond timestamp ties.
    public let sequenceNumber: Int64?
    /// Per-process SDK identity used to reject navigation from replaced app processes.
    public let sessionId: String?
    /// Persistent process order used to reject delayed events from an older SDK session.
    public let sessionEpoch: Int64?
    /// Monotonic SDK tracking state used to order enable/disable control events.
    public let trackingGeneration: Int64?
    public let destination: String
    public let source: NavigationSourceType
    public let arguments: [String: String]
    public let metadata: [String: String]

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        sequenceNumber: Int64? = nil,
        sessionId: String? = nil,
        sessionEpoch: Int64? = nil,
        trackingGeneration: Int64? = nil,
        destination: String,
        source: NavigationSourceType,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        self.timestamp = timestamp
        self.sequenceNumber = sequenceNumber
        self.sessionId = sessionId
        self.sessionEpoch = sessionEpoch
        self.trackingGeneration = trackingGeneration
        self.destination = destination
        self.source = source
        self.arguments = arguments
        self.metadata = metadata
    }
}

/// A handled (non-fatal) exception event with stack trace and device context.
public struct SdkHandledExceptionEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .handledException
    public let timestamp: Int64
    public let errorDomain: String
    public let errorMessage: String?
    public let stackTrace: String
    public let customMessage: String?
    public let currentScreen: String?
    public let bundleId: String
    public let appVersion: String?
    public let deviceInfo: SdkDeviceInfo

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        errorDomain: String,
        errorMessage: String?,
        stackTrace: String,
        customMessage: String?,
        currentScreen: String?,
        bundleId: String,
        appVersion: String?,
        deviceInfo: SdkDeviceInfo
    ) {
        self.timestamp = timestamp
        self.errorDomain = errorDomain
        self.errorMessage = errorMessage
        self.stackTrace = stackTrace
        self.customMessage = customMessage
        self.currentScreen = currentScreen
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.deviceInfo = deviceInfo
    }
}

/// An unhandled crash event captured by exception or signal handlers.
public struct SdkCrashEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .crash
    public let timestamp: Int64
    public let errorDomain: String
    public let errorMessage: String?
    public let stackTrace: String
    public let currentScreen: String?
    public let bundleId: String
    public let appVersion: String?
    public let deviceInfo: SdkDeviceInfo

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        errorDomain: String,
        errorMessage: String?,
        stackTrace: String,
        currentScreen: String?,
        bundleId: String,
        appVersion: String?,
        deviceInfo: SdkDeviceInfo
    ) {
        self.timestamp = timestamp
        self.errorDomain = errorDomain
        self.errorMessage = errorMessage
        self.stackTrace = stackTrace
        self.currentScreen = currentScreen
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.deviceInfo = deviceInfo
    }
}

/// A main-thread hang event with duration and diagnostic stack trace.
public struct SdkHangEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .hang
    public let timestamp: Int64
    public let durationMs: Double
    public let stackTrace: String?
    public let bundleId: String

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        durationMs: Double,
        stackTrace: String?,
        bundleId: String
    ) {
        self.timestamp = timestamp
        self.durationMs = durationMs
        self.stackTrace = stackTrace
        self.bundleId = bundleId
    }
}

/// A network request/response event with URL, status code, timing, and optional body capture.
public struct SdkNetworkRequestEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .networkRequest
    public let timestamp: Int64
    public let url: String
    public let method: String
    public let requestId: String?
    public let connectionId: String?
    public let direction: NetworkCaptureDirection?
    public let protocolName: String?
    public let metadata: [String: String]?
    public let sequenceNumber: UInt64?
    public let requestHeaders: [String: String]?
    public let requestBodySize: Int?
    public let statusCode: Int?
    public let responseHeaders: [String: String]?
    public let responseBodySize: Int?
    public let durationMs: Double?
    public let error: String?
    public let host: String?
    public let path: String?
    public let requestBody: String?
    public let responseBody: String?
    public let contentType: String?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        url: String,
        method: String,
        requestId: String? = nil,
        connectionId: String? = nil,
        direction: NetworkCaptureDirection? = nil,
        protocolName: String? = nil,
        metadata: [String: String]? = nil,
        sequenceNumber: UInt64? = nil,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil,
        statusCode: Int? = nil,
        responseHeaders: [String: String]? = nil,
        responseBodySize: Int? = nil,
        durationMs: Double? = nil,
        error: String? = nil,
        host: String? = nil,
        path: String? = nil,
        requestBody: String? = nil,
        responseBody: String? = nil,
        contentType: String? = nil
    ) {
        self.timestamp = timestamp
        self.url = url
        self.method = method
        self.requestId = requestId
        self.connectionId = connectionId
        self.direction = direction
        self.protocolName = protocolName
        self.metadata = metadata
        self.sequenceNumber = sequenceNumber
        self.requestHeaders = requestHeaders
        self.requestBodySize = requestBodySize
        self.statusCode = statusCode
        self.responseHeaders = responseHeaders
        self.responseBodySize = responseBodySize
        self.durationMs = durationMs
        self.error = error
        self.host = host
        self.path = path
        self.requestBody = requestBody
        self.responseBody = responseBody
        self.contentType = contentType
    }
}

/// A WebSocket frame event recording direction, type, and payload size.
public struct SdkWebSocketFrameEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .webSocketFrame
    public let timestamp: Int64
    public let url: String
    public let direction: WebSocketFrameDirection
    public let frameType: WebSocketFrameType
    public let payloadSize: Int?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        url: String,
        direction: WebSocketFrameDirection,
        frameType: WebSocketFrameType,
        payloadSize: Int? = nil
    ) {
        self.timestamp = timestamp
        self.url = url
        self.direction = direction
        self.frameType = frameType
        self.payloadSize = payloadSize
    }
}

/// Direction of a WebSocket frame (sent or received).
public enum WebSocketFrameDirection: String, Codable, Sendable {
    case sent
    case received
}

/// Type of a WebSocket frame (text, binary, ping, pong, close).
public enum WebSocketFrameType: String, Codable, Sendable {
    case text
    case binary
    case ping
    case pong
    case close
}

/// A log event with level, tag, and message.
public struct SdkLogEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .log
    public let timestamp: Int64
    public let level: LogLevel
    public let tag: String?
    public let message: String

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        level: LogLevel,
        tag: String?,
        message: String
    ) {
        self.timestamp = timestamp
        self.level = level
        self.tag = tag
        self.message = message
    }
}

/// Log severity level, ordered from verbose (lowest) to fault (highest).
public enum LogLevel: Int, Codable, Sendable, Comparable {
    case verbose = 0
    case debug = 1
    case info = 2
    case warning = 3
    case error = 4
    case fault = 5

    public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// An app lifecycle event (foreground, background, terminated, etc.).
public struct SdkLifecycleEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .lifecycle
    public let timestamp: Int64
    public let state: String
    public let bundleId: String?
    public let details: [String: String]
    public let sessionId: String?
    public let sessionEpoch: Int64?
    public let trackingGeneration: Int64?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        state: String,
        bundleId: String? = nil,
        details: [String: String] = [:],
        sessionId: String? = nil,
        sessionEpoch: Int64? = nil,
        trackingGeneration: Int64? = nil
    ) {
        self.timestamp = timestamp
        self.state = state
        self.bundleId = bundleId
        self.details = details
        self.sessionId = sessionId
        self.sessionEpoch = sessionEpoch
        self.trackingGeneration = trackingGeneration
    }
}

/// A notification action tap event.
public struct SdkNotificationActionEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .notificationAction
    public let timestamp: Int64
    public let actionId: String
    public let notificationTitle: String?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        actionId: String,
        notificationTitle: String? = nil
    ) {
        self.timestamp = timestamp
        self.actionId = actionId
        self.notificationTitle = notificationTitle
    }
}

/// A periodic snapshot of SwiftUI view body evaluation metrics.
public struct SdkViewBodySnapshotEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .viewBodySnapshot
    public let timestamp: Int64
    public let snapshots: [ViewBodySnapshot]

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        snapshots: [ViewBodySnapshot]
    ) {
        self.timestamp = timestamp
        self.snapshots = snapshots
    }
}

/// A view hierarchy snapshot event pushed when the in-process UIView tree changes.
public struct SdkViewHierarchyEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .viewHierarchy
    public let timestamp: Int64
    public let hierarchy: SdkViewHierarchy

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        hierarchy: SdkViewHierarchy
    ) {
        self.timestamp = timestamp
        self.hierarchy = hierarchy
    }
}

/// A snapshot of a single view's body evaluation count and average duration.
public struct ViewBodySnapshot: Codable, Sendable {
    public let id: String
    public let viewName: String?
    public let totalCount: Int
    public let rollingAverage: Double
    public let averageDurationMs: Double?

    public init(
        id: String,
        viewName: String?,
        totalCount: Int,
        rollingAverage: Double,
        averageDurationMs: Double?
    ) {
        self.id = id
        self.viewName = viewName
        self.totalCount = totalCount
        self.rollingAverage = rollingAverage
        self.averageDurationMs = averageDurationMs
    }
}

/// Wire-format navigation source discriminator, matching ``NavigationSource`` cases.
public enum NavigationSourceType: String, Codable, Sendable {
    case swiftUINavigation = "swiftui_navigation"
    case uiKitNavigation = "uikit_navigation"
    case deepLink = "deep_link"
    case custom
}

/// Device metadata attached to crash and failure events.
public struct SdkDeviceInfo: Codable, Sendable {
    public let model: String
    public let manufacturer: String
    public let osVersion: String
    public let systemName: String

    public init(
        model: String,
        manufacturer: String = "Apple",
        osVersion: String,
        systemName: String
    ) {
        self.model = model
        self.manufacturer = manufacturer
        self.osVersion = osVersion
        self.systemName = systemName
    }
}

/// Wrapper for type-erased event serialization.
public struct SdkEventEnvelope: Codable, Sendable {
    public let eventType: SdkEventType
    public let payload: Data

    public init<E: SdkEvent>(_ event: E) throws {
        self.eventType = event.eventType
        self.payload = try JSONEncoder().encode(event)
    }
}

/// A system notification broadcast event (locale change, memory warning, etc.).
public struct SdkBroadcastEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .broadcast
    public let timestamp: Int64
    public let action: String
    public let categories: [String]?
    public let infoKeyTypes: [String: String]?

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        action: String,
        categories: [String]? = nil,
        infoKeyTypes: [String: String]? = nil
    ) {
        self.timestamp = timestamp
        self.action = action
        self.categories = categories
        self.infoKeyTypes = infoKeyTypes
    }
}

/// A user interaction event (tap, gesture) with coordinates and target view info.
public struct SdkInteractionEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .interaction
    public let timestamp: Int64
    public let interactionType: String
    public let properties: [String: String]

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        interactionType: String,
        properties: [String: String] = [:]
    ) {
        self.timestamp = timestamp
        self.interactionType = interactionType
        self.properties = properties
    }
}

/// A UserDefaults change event with suite, key, and value metadata.
///
/// Wire-contract note: the TS ingestor (`IosSdkEventIngestor`) maps
/// `suiteName` → `fileName` and `newValue` → `value` to match Android's
/// storage telemetry wire format (Android emits `fileName`/`value`). Don't
/// assume iOS uses Android's field names.
public struct SdkStorageChangedEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .storageChanged
    public let timestamp: Int64
    /// The UserDefaults suite; maps to `fileName` in the TS ingestor.
    public let suiteName: String?
    public let key: String?
    /// The value after the change (nil for a removal); maps to `value` in TS.
    public let newValue: String?
    /// The value BEFORE the change (nil if there was no prior value). Emitted so the
    /// TS telemetry ingest can skip its per-insert previous-value lookup (#3000).
    public let previousValue: String?
    public let valueType: String
    /// The kind of change this event records: "add", "modify", or "remove".
    /// Mirrors Android's storage `changeType` so the desktop telemetry consumer
    /// can render added/removed values instead of always treating iOS as "modify".
    public let changeType: String
    public let sequenceNumber: Int64

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        suiteName: String?,
        key: String?,
        newValue: String?,
        previousValue: String? = nil,
        valueType: String,
        changeType: String = "modify",
        sequenceNumber: Int64
    ) {
        self.timestamp = timestamp
        self.suiteName = suiteName
        self.key = key
        self.newValue = newValue
        self.previousValue = previousValue
        self.valueType = valueType
        self.changeType = changeType
        self.sequenceNumber = sequenceNumber
    }

    private enum CodingKeys: String, CodingKey {
        case eventType, timestamp, suiteName, key, newValue, previousValue, valueType, changeType, sequenceNumber
    }

    // Custom decode so events persisted by an older SDK build (before
    // `changeType`/`previousValue` existed) still load — `EventPersistence
    // .loadPending()` decodes `SdkStorageChangedEvent`, and Swift's synthesized
    // `Decodable` would reject the missing keys and silently drop the event.
    // Legacy payloads default `changeType` to "modify" (the prior implicit
    // behavior) and leave `previousValue` nil.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let type = try container.decodeIfPresent(SdkEventType.self, forKey: .eventType) {
            eventType = type
        }
        timestamp = try container.decode(Int64.self, forKey: .timestamp)
        suiteName = try container.decodeIfPresent(String.self, forKey: .suiteName)
        key = try container.decodeIfPresent(String.self, forKey: .key)
        newValue = try container.decodeIfPresent(String.self, forKey: .newValue)
        previousValue = try container.decodeIfPresent(String.self, forKey: .previousValue)
        valueType = try container.decode(String.self, forKey: .valueType)
        changeType = try container.decodeIfPresent(String.self, forKey: .changeType) ?? "modify"
        sequenceNumber = try container.decode(Int64.self, forKey: .sequenceNumber)
    }
}

/// Batch of events for efficient transmission.
public struct SdkEventBatch: Codable, Sendable {
    public let bundleId: String?
    public let events: [SdkEventEnvelope]
    public let timestamp: Int64

    public init(
        bundleId: String?,
        events: [SdkEventEnvelope],
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) {
        self.bundleId = bundleId
        self.events = events
        self.timestamp = timestamp
    }
}
