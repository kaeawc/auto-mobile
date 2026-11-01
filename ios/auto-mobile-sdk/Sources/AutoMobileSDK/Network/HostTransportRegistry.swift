import AutoMobileSdkWire
import Foundation
import os

/// A network transport family a host registers with ``AutoMobileNetwork`` (#5160).
///
/// The raw value is the capability id reported by ``AutoMobileNetwork/transportCapabilities()``.
public enum HostTransport: String, CaseIterable, Sendable {
    /// Default and custom `URLSession`s, captured by the SDK's `URLProtocol`.
    case urlSession = "network.transport.urlsession"
    /// Background `URLSession`s, which ignore `protocolClasses`; the host forwards delegate callbacks.
    case backgroundURLSession = "network.transport.urlsession.background"
    /// `URLSessionWebSocketTask` frames forwarded by the host.
    case webSocket = "network.transport.websocket"
    /// Network.framework `NWConnection` callbacks forwarded by the host.
    case nwConnection = "network.transport.nwconnection"
    /// Any other stack (custom sockets, third-party transports). Never registrable; record manually.
    case other = "network.transport.other"
}

/// How the SDK captures a `URLSession` registered with ``AutoMobileNetwork/registerURLSession(_:)``.
public struct URLSessionRegistration: Sendable {
    public enum Mode: String, Sendable {
        /// The SDK's `URLProtocol` was installed in the configuration; nothing else to call.
        case urlProtocol
        /// A background configuration: forward the session delegate's callbacks to ``adapter``.
        case delegateForwarding
    }

    public let transport: HostTransport
    public let mode: Mode
    /// Non-nil only for ``Mode/delegateForwarding``. A `URLProtocol` session has no adapter, so
    /// its requests cannot be recorded twice.
    public let adapter: URLSessionNetworkCaptureAdapter?
}

/// Which transport families the host registered, and the capability state each one implies.
final class HostTransportRegistry: Sendable {
    static let hostOptInReason = "HOST_OPT_IN"
    static let notInitializedReason = "NETWORK_CAPTURE_NOT_INITIALIZED"
    static let disabledReason = "NETWORK_CAPTURE_DISABLED"
    static let noAdapterReason = "NO_ADAPTER"

    private let registered = OSAllocatedUnfairLock(initialState: Set<HostTransport>())

    func register(_ transport: HostTransport) {
        registered.withLock { _ = $0.insert(transport) }
    }

    func isRegistered(_ transport: HostTransport) -> Bool {
        registered.withLock { $0.contains(transport) }
    }

    func reset() {
        registered.withLock { $0.removeAll() }
    }

    /// One descriptor per ``HostTransport``, in declaration order.
    func descriptors(
        networkInitialized: Bool,
        networkEnabled: Bool,
        faultRulesAvailable: Bool
    )
        -> [SdkCapabilityDescriptor]
    {
        let snapshot = registered.withLock { $0 }
        return HostTransport.allCases.map { transport in
            Self.descriptor(
                for: transport,
                registered: snapshot.contains(transport),
                networkInitialized: networkInitialized,
                networkEnabled: networkEnabled,
                faultRulesAvailable: faultRulesAvailable
            )
        }
    }

    static func descriptor(
        for transport: HostTransport,
        registered: Bool,
        networkInitialized: Bool,
        networkEnabled: Bool,
        faultRulesAvailable: Bool
    )
        -> SdkCapabilityDescriptor
    {
        let (state, reason): (SdkCapabilityState, String?) = if transport == .other {
            (.unsupported, noAdapterReason)
        } else if !networkInitialized {
            (.notInitialized, notInitializedReason)
        } else if !networkEnabled {
            (.disabled, disabledReason)
        } else if !registered {
            (.disabled, hostOptInReason)
        } else {
            (.supported, nil)
        }
        let enforcedActions = state == .supported && faultRulesAvailable ? enforcedFaultActions(transport) : nil
        let enforcement: SdkFaultEnforcement = if state != .supported || !faultRulesAvailable {
            .notEnforceable
        } else if enforcedActions != nil {
            .enforced
        } else {
            .evaluateOnly
        }
        return SdkCapabilityDescriptor(
            id: transport.rawValue, state: state, reason: reason, faultEnforcement: enforcement,
            faultActions: (enforcedActions ?? []).map(\.rawValue)
        )
    }

    /// The fault actions the SDK applies on `transport`, or nil when the host must apply decisions.
    /// The URLProtocol serves fail, delayed and synthetic responses; the WebSocket and NWConnection
    /// adapters apply delay and fail (#5163). Background sessions only evaluate.
    static func enforcedFaultActions(_ transport: HostTransport) -> [NetworkFaultAction]? {
        switch transport {
        case .urlSession: [.closeConnection, .dropBytes, .error, .latency, .response, .status]
        case .webSocket, .nwConnection: AdapterFaultOutcome.enforcedActions
        case .backgroundURLSession, .other: nil
        }
    }
}
