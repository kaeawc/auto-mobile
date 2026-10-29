import Foundation

/// Whether the app's observation bridge can serve observations and actions (#5159). Carried in the
/// SDK's `/health` payload and passed through CtrlProxy's `get_sdk_capabilities` reply unchanged.
public struct ObservationBridgeState: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1
    /// No bridge is registered with the SDK.
    public static let notRegisteredReason = "NOT_REGISTERED"

    public let schemaVersion: Int
    public let available: Bool
    /// Why the bridge is unavailable; nil when ``available`` is true.
    public let reason: String?
    /// Action kinds the host's executor accepts, sorted. Empty when unavailable.
    public let supportedActions: [String]

    public init(
        schemaVersion: Int = ObservationBridgeState.currentSchemaVersion,
        available: Bool,
        reason: String? = nil,
        supportedActions: [String] = []
    ) {
        self.schemaVersion = schemaVersion
        self.available = available
        self.reason = reason
        self.supportedActions = supportedActions.sorted()
    }

    public static let notRegistered = ObservationBridgeState(available: false, reason: notRegisteredReason)
}

// MARK: - Observation bridge values (#5159)
//
// Shared by the SDK, which serves them, and CtrlProxy, which relays them.

/// Coordinate systems used by observation bounds and gesture points.
public enum AutoMobileCoordinateSpace: String, Codable, Sendable {
    case screen
    case window
    case view
}

/// Device orientation captured with an observation.
public enum AutoMobileDeviceOrientation: String, Codable, Sendable {
    case portrait
    case portraitUpsideDown
    case landscapeLeft
    case landscapeRight
    case unknown
}

/// A semantic node published by a host renderer.
public struct AutoMobileObservationNode: Codable, Sendable, Equatable {
    public let id: String
    public let role: String
    public let label: String?
    public let value: String?
    public let bounds: SdkBounds
    public let enabled: Bool
    public let visible: Bool
    public let focused: Bool
    public let children: [AutoMobileObservationNode]

    public init(
        id: String,
        role: String,
        label: String? = nil,
        value: String? = nil,
        bounds: SdkBounds,
        enabled: Bool = true,
        visible: Bool = true,
        focused: Bool = false,
        children: [AutoMobileObservationNode] = []
    ) {
        self.id = id
        self.role = role
        self.label = label
        self.value = value
        self.bounds = bounds
        self.enabled = enabled
        self.visible = visible
        self.focused = focused
        self.children = children
    }

    public func contains(id: String) -> Bool {
        self.id == id || children.contains { $0.contains(id: id) }
    }

    public func node(id: String) -> AutoMobileObservationNode? {
        if self.id == id { return self }
        for child in children {
            if let match = child.node(id: id) { return match }
        }
        return nil
    }
}

/// Immutable in-process UI observation. `captureIdentity` changes for every capture.
public struct AutoMobileObservationSnapshot: Codable, Sendable, Equatable {
    public let captureIdentity: UInt64
    public let orientation: AutoMobileDeviceOrientation
    public let coordinateSpace: AutoMobileCoordinateSpace
    public let bounds: SdkBounds
    public let root: AutoMobileObservationNode?
    public let focusedElementId: String?
    public let capabilities: Set<String>

    public init(
        captureIdentity: UInt64,
        orientation: AutoMobileDeviceOrientation = .unknown,
        coordinateSpace: AutoMobileCoordinateSpace,
        bounds: SdkBounds,
        root: AutoMobileObservationNode?,
        focusedElementId: String? = nil,
        capabilities: Set<String> = []
    ) {
        self.captureIdentity = captureIdentity
        self.orientation = orientation
        self.coordinateSpace = coordinateSpace
        self.bounds = bounds
        self.root = root
        self.focusedElementId = focusedElementId
        self.capabilities = capabilities
    }

    public func containsElement(id: String) -> Bool {
        root?.contains(id: id) ?? false
    }
}

/// Actions accepted by the host-app control bridge.
public enum AutoMobileAction: Codable, Sendable, Equatable {
    case tap(observationIdentity: UInt64, elementId: String)
    case longPress(observationIdentity: UInt64, elementId: String, durationMs: Int)
    case swipe(observationIdentity: UInt64, start: SdkPoint, end: SdkPoint, durationMs: Int)
    case drag(observationIdentity: UInt64, elementId: String, end: SdkPoint, durationMs: Int)
    case pinch(observationIdentity: UInt64, elementId: String, scale: Double, durationMs: Int)
    case insertText(observationIdentity: UInt64, elementId: String, text: String)
    case clearText(observationIdentity: UInt64, elementId: String)
    case back(observationIdentity: UInt64)
    case scroll(observationIdentity: UInt64, elementId: String?, delta: SdkPoint)

    public var observationIdentity: UInt64 {
        switch self {
        case let .tap(identity, _), let .longPress(identity, _, _),
             let .swipe(identity, _, _, _), let .drag(identity, _, _, _),
             let .pinch(identity, _, _, _), let .insertText(identity, _, _),
             let .clearText(identity, _), let .back(identity),
             let .scroll(identity, _, _):
            return identity
        }
    }

    public var targetElementId: String? {
        switch self {
        case let .tap(_, id), let .longPress(_, id, _), let .drag(_, id, _, _),
             let .pinch(_, id, _, _), let .insertText(_, id, _), let .clearText(_, id):
            return id
        case let .scroll(_, id, _):
            return id
        case .swipe, .back:
            return nil
        }
    }
}

public struct SdkPoint: Codable, Sendable, Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// Structured result from one host action.
public struct AutoMobileActionResult: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case accepted
        case rejected
        case cancelled
    }

    public let status: Status
    public let reason: String?
    public let durationMs: Double
    public let nextObservationIdentity: UInt64?

    public init(status: Status, reason: String? = nil, durationMs: Double = 0, nextObservationIdentity: UInt64? = nil) {
        self.status = status
        self.reason = reason
        self.durationMs = durationMs
        self.nextObservationIdentity = nextObservationIdentity
    }
}
