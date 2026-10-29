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
