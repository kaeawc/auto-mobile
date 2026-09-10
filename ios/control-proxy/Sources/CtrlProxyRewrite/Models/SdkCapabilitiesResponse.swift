import Foundation

/// Foreground-app-scoped capabilities exposed by the optional in-app AutoMobile SDK.
public enum SdkCapability: String, CaseIterable, Codable, Sendable {
    case hierarchy
    case networkMocking = "network_mocking"
    case networkFaultRules = "network_fault_rules"
    case networkErrorSimulation = "network_error_simulation"
    case database
    case highlight
}

/// Dynamic SDK availability. Unlike `ConnectedEvent.supportedCommands`, this describes
/// the currently foreground app and may change without restarting CtrlProxy.
public struct SdkCapabilitiesResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let available: Bool
    public let bundleId: String?
    public let capabilities: [String]
    public let totalTimeMs: Int64

    public init(
        requestId: String?,
        available: Bool,
        bundleId: String?,
        capabilities: [String],
        totalTimeMs: Int64
    ) {
        type = ResponseType.sdkCapabilitiesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        success = true
        self.available = available
        self.bundleId = bundleId
        self.capabilities = capabilities.sorted()
        self.totalTimeMs = totalTimeMs
    }
}
