import Foundation

/// Base protocol for all SDK events sent from the AutoMobile SDK.
public protocol SdkEvent: Codable, Sendable {
    var eventType: SdkEventType { get }
    var timestamp: TimeInterval { get }
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
    case custom
    case notificationAction = "notification_action"
    case viewBodySnapshot = "view_body_snapshot"
}

// MARK: - Event Types

public struct SdkNavigationEvent: SdkEvent {
    public let eventType: SdkEventType = .navigation
    public let timestamp: TimeInterval
    public let destination: String
    public let source: NavigationSourceType
    public let arguments: [String: String]
    public let metadata: [String: String]

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        destination: String,
        source: NavigationSourceType,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        self.timestamp = timestamp
        self.destination = destination
        self.source = source
        self.arguments = arguments
        self.metadata = metadata
    }
}

public struct SdkHandledExceptionEvent: SdkEvent {
    public let eventType: SdkEventType = .handledException
    public let timestamp: TimeInterval
    public let errorDomain: String
    public let errorMessage: String?
    public let stackTrace: String
    public let customMessage: String?
    public let currentScreen: String?
    public let bundleId: String
    public let appVersion: String?
    public let deviceInfo: SdkDeviceInfo

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
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

public struct SdkCrashEvent: SdkEvent {
    public let eventType: SdkEventType = .crash
    public let timestamp: TimeInterval
    public let errorDomain: String
    public let errorMessage: String?
    public let stackTrace: String
    public let currentScreen: String?
    public let bundleId: String
    public let appVersion: String?
    public let deviceInfo: SdkDeviceInfo

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
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

public struct SdkHangEvent: SdkEvent {
    public let eventType: SdkEventType = .hang
    public let timestamp: TimeInterval
    public let durationMs: Double
    public let stackTrace: String?
    public let bundleId: String

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
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

public struct SdkNetworkRequestEvent: SdkEvent {
    public let eventType: SdkEventType = .networkRequest
    public let timestamp: TimeInterval
    public let url: String
    public let method: String
    public let requestHeaders: [String: String]?
    public let requestBodySize: Int?
    public let statusCode: Int?
    public let responseHeaders: [String: String]?
    public let responseBodySize: Int?
    public let durationMs: Double?
    public let error: String?

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        url: String,
        method: String,
        requestHeaders: [String: String]? = nil,
        requestBodySize: Int? = nil,
        statusCode: Int? = nil,
        responseHeaders: [String: String]? = nil,
        responseBodySize: Int? = nil,
        durationMs: Double? = nil,
        error: String? = nil
    ) {
        self.timestamp = timestamp
        self.url = url
        self.method = method
        self.requestHeaders = requestHeaders
        self.requestBodySize = requestBodySize
        self.statusCode = statusCode
        self.responseHeaders = responseHeaders
        self.responseBodySize = responseBodySize
        self.durationMs = durationMs
        self.error = error
    }
}

public struct SdkWebSocketFrameEvent: SdkEvent {
    public let eventType: SdkEventType = .webSocketFrame
    public let timestamp: TimeInterval
    public let url: String
    public let direction: WebSocketFrameDirection
    public let frameType: WebSocketFrameType
    public let payloadSize: Int?

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
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

public enum WebSocketFrameDirection: String, Codable, Sendable {
    case sent
    case received
}

public enum WebSocketFrameType: String, Codable, Sendable {
    case text
    case binary
    case ping
    case pong
    case close
}

public struct SdkLogEvent: SdkEvent {
    public let eventType: SdkEventType = .log
    public let timestamp: TimeInterval
    public let level: LogLevel
    public let tag: String?
    public let message: String
    public let filterName: String

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        level: LogLevel,
        tag: String?,
        message: String,
        filterName: String
    ) {
        self.timestamp = timestamp
        self.level = level
        self.tag = tag
        self.message = message
        self.filterName = filterName
    }
}

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

public struct SdkLifecycleEvent: SdkEvent {
    public let eventType: SdkEventType = .lifecycle
    public let timestamp: TimeInterval
    public let state: String
    public let bundleId: String?

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        state: String,
        bundleId: String? = nil
    ) {
        self.timestamp = timestamp
        self.state = state
        self.bundleId = bundleId
    }
}

public struct SdkCustomEvent: SdkEvent {
    public let eventType: SdkEventType = .custom
    public let timestamp: TimeInterval
    public let name: String
    public let properties: [String: String]

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        name: String,
        properties: [String: String] = [:]
    ) {
        self.timestamp = timestamp
        self.name = name
        self.properties = properties
    }
}

public struct SdkNotificationActionEvent: SdkEvent {
    public let eventType: SdkEventType = .notificationAction
    public let timestamp: TimeInterval
    public let actionId: String
    public let notificationTitle: String?

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        actionId: String,
        notificationTitle: String? = nil
    ) {
        self.timestamp = timestamp
        self.actionId = actionId
        self.notificationTitle = notificationTitle
    }
}

public struct SdkViewBodySnapshotEvent: SdkEvent {
    public let eventType: SdkEventType = .viewBodySnapshot
    public let timestamp: TimeInterval
    public let snapshots: [ViewBodySnapshot]

    public init(
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        snapshots: [ViewBodySnapshot]
    ) {
        self.timestamp = timestamp
        self.snapshots = snapshots
    }
}

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

public enum NavigationSourceType: String, Codable, Sendable {
    case swiftUINavigation = "swiftui_navigation"
    case uiKitNavigation = "uikit_navigation"
    case deepLink = "deep_link"
    case custom
}

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

/// Batch of events for efficient transmission.
public struct SdkEventBatch: Codable, Sendable {
    public let bundleId: String?
    public let events: [SdkEventEnvelope]
    public let timestamp: TimeInterval

    public init(
        bundleId: String?,
        events: [SdkEventEnvelope],
        timestamp: TimeInterval = Date().timeIntervalSince1970
    ) {
        self.bundleId = bundleId
        self.events = events
        self.timestamp = timestamp
    }
}
