import Foundation

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

/// Host-owned observation source. UIKit, SwiftUI, and custom renderers implement this protocol.
public protocol AutoMobileObservationProvider: AnyObject, Sendable {
    func captureObservation() async -> AutoMobileObservationSnapshot
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

/// Host action implementation. The SDK never claims success when the host rejects an action.
public protocol AutoMobileActionExecutor: AnyObject, Sendable {
    func execute(_ action: AutoMobileAction) async -> AutoMobileActionResult
}

/// Serial, bounded action queue with cancellation and explicit overload results.
public actor AutoMobileSerialActionQueue: AutoMobileActionExecutor {
    public typealias Performer = @Sendable (AutoMobileAction) async -> AutoMobileActionResult
    private let capacity: Int
    private let performer: Performer
    private var queued = 0

    public init(capacity: Int = 32, performer: @escaping Performer) {
        self.capacity = max(1, capacity)
        self.performer = performer
    }

    public func execute(_ action: AutoMobileAction) async -> AutoMobileActionResult {
        guard queued < capacity else {
            return AutoMobileActionResult(status: .rejected, reason: "action_queue_overloaded")
        }
        queued += 1
        defer { queued -= 1 }
        guard !Task.isCancelled else {
            return AutoMobileActionResult(status: .cancelled, reason: "action_cancelled")
        }
        let result = await performer(action)
        guard !Task.isCancelled else {
            return AutoMobileActionResult(status: .cancelled, reason: "action_cancelled")
        }
        return result
    }
}

/// Atomic observation/action coordinator shared by UIKit, SwiftUI, and custom hosts.
public actor AutoMobileObservationBridge {
    private let provider: any AutoMobileObservationProvider
    private let executor: any AutoMobileActionExecutor
    private var currentObservation: AutoMobileObservationSnapshot?
    private var actionInFlight = false

    public init(
        provider: any AutoMobileObservationProvider,
        executor: any AutoMobileActionExecutor
    ) {
        self.provider = provider
        self.executor = executor
    }

    public func observe() async -> AutoMobileObservationSnapshot {
        let snapshot = await provider.captureObservation()
        currentObservation = snapshot
        return snapshot
    }

    public func perform(_ action: AutoMobileAction) async -> AutoMobileActionResult {
        let observation: AutoMobileObservationSnapshot
        if let currentObservation {
            observation = currentObservation
        } else {
            observation = await provider.captureObservation()
        }
        currentObservation = observation
        guard observation.captureIdentity == action.observationIdentity else {
            return AutoMobileActionResult(status: .rejected, reason: "stale_observation")
        }
        if let target = action.targetElementId, !observation.containsElement(id: target) {
            return AutoMobileActionResult(status: .rejected, reason: "unknown_element")
        }
        if let target = action.targetElementId {
            guard let node = observation.root?.node(id: target) else {
                return AutoMobileActionResult(status: .rejected, reason: "unknown_element")
            }
            guard node.enabled && node.visible else {
                return AutoMobileActionResult(status: .rejected, reason: "element_not_actionable")
            }
        }
        guard !actionInFlight else {
            return AutoMobileActionResult(status: .rejected, reason: "action_in_flight")
        }
        actionInFlight = true
        defer { actionInFlight = false }
        let result = await executor.execute(action)
        guard result.status == .accepted else { return result }
        let next = await provider.captureObservation()
        currentObservation = next
        return AutoMobileActionResult(
            status: .accepted,
            durationMs: result.durationMs,
            nextObservationIdentity: next.captureIdentity
        )
    }
}
