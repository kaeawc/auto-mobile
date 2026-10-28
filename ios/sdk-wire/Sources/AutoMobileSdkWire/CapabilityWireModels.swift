import Foundation

/// Availability of one SDK capability. The values and their JSON spelling match the Android SDK's
/// `SdkCapabilityState`, so one host-side parser reads both platforms (#5160).
public enum SdkCapabilityState: String, Codable, Equatable, Sendable {
    case supported = "SUPPORTED"
    case disabled = "DISABLED"
    case unsupported = "UNSUPPORTED"
    case permissionDenied = "PERMISSION_DENIED"
    case notInitialized = "NOT_INITIALIZED"
    case unknown = "UNKNOWN"

    /// A state written by a newer SDK decodes as ``unknown``, as the Android decoder does.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SdkCapabilityState(rawValue: raw) ?? .unknown
    }
}

/// Whether the SDK applies a matched network fault rule on a transport.
public enum SdkFaultEnforcement: String, Codable, Equatable, Sendable {
    /// The SDK applies the decision itself on this transport.
    case enforced = "ENFORCED"
    /// The SDK evaluates rules, but the host must apply the returned decision.
    case evaluateOnly = "EVALUATE_ONLY"
    /// No rule can take effect on this transport.
    case notEnforceable = "NONE"
}

/// One capability and its current state, in the Android `SdkCapabilityDescriptor` shape. Transport
/// descriptors also carry ``faultEnforcement``; Android parsers ignore the extra key.
public struct SdkCapabilityDescriptor: Codable, Equatable, Sendable {
    public let id: String
    public let state: SdkCapabilityState
    public let reason: String?
    public let faultEnforcement: SdkFaultEnforcement?

    public init(
        id: String,
        state: SdkCapabilityState,
        reason: String? = nil,
        faultEnforcement: SdkFaultEnforcement? = nil
    ) {
        self.id = id
        self.state = state
        self.reason = reason
        self.faultEnforcement = faultEnforcement
    }
}
