import AutoMobileSdkWire
import Foundation
import os

/// The kind of an ``AutoMobileAction``, as reported in ``ObservationBridgeState/supportedActions``.
public enum AutoMobileActionKind: String, CaseIterable, Codable, Sendable {
    case tap
    case longPress
    case swipe
    case drag
    case pinch
    case insertText
    case clearText
    case back
    case scroll
}

extension AutoMobileAction {
    public var kind: AutoMobileActionKind {
        switch self {
        case .tap: .tap
        case .longPress: .longPress
        case .swipe: .swipe
        case .drag: .drag
        case .pinch: .pinch
        case .insertText: .insertText
        case .clearText: .clearText
        case .back: .back
        case .scroll: .scroll
        }
    }
}

/// Holds the host's ``AutoMobileObservationBridge`` so AutoMobile can discover it (#5159).
///
/// Registration is explicit: the SDK never builds a bridge on its own, and an app without one
/// reports `available: false` with reason `NOT_REGISTERED`.
public final class AutoMobileObservationRegistry: Sendable {
    public static let shared = AutoMobileObservationRegistry()

    private struct Registration: Sendable {
        let bridge: AutoMobileObservationBridge
        let supportedActions: Set<AutoMobileActionKind>
    }

    private let registration = OSAllocatedUnfairLock<Registration?>(initialState: nil)

    init() {}

    /// Registers the app's bridge, replacing any earlier one. `supportedActions` lists the action
    /// kinds the bridge's executor handles; AutoMobile treats any other kind as unsupported.
    public func register(
        _ bridge: AutoMobileObservationBridge,
        supportedActions: Set<AutoMobileActionKind> = Set(AutoMobileActionKind.allCases)
    ) {
        registration.withLock { $0 = Registration(bridge: bridge, supportedActions: supportedActions) }
    }

    /// Removes the registered bridge; discovery then reports `NOT_REGISTERED`.
    public func unregister() {
        registration.withLock { $0 = nil }
    }

    /// The registered bridge, if any.
    public var bridge: AutoMobileObservationBridge? {
        registration.withLock { $0?.bridge }
    }

    /// The discovery state served in the SDK's `/health` payload.
    public var state: ObservationBridgeState {
        guard let current = registration.withLock({ $0 }) else { return .notRegistered }
        return ObservationBridgeState(available: true, supportedActions: current.supportedActions.map(\.rawValue))
    }
}
