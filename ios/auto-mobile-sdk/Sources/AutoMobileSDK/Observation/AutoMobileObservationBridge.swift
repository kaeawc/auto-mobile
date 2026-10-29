import Foundation

/// Host-owned observation source. UIKit, SwiftUI, and custom renderers implement this protocol.
public protocol AutoMobileObservationProvider: AnyObject, Sendable {
    func captureObservation() async -> AutoMobileObservationSnapshot
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
