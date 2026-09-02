import Foundation

/// The one-shot event pushed to a client on WebSocket upgrade. `supportedCommands`
/// (every `RequestType` raw value, sorted) and `supportedFeatures` (every
/// `RunnerFeature` raw value, sorted) are the runner-version signals the daemon
/// has — dropping/reordering/renaming a command or feature breaks version-skew
/// detection, so their derivation from `.allCases` is load-bearing (#5787).
public struct ConnectedEvent: Codable, Sendable {
    public let type: String
    public let id: Int
    public let supportedCommands: [String]
    public let supportedFeatures: [String]

    public init(id: Int) {
        type = "connected"
        self.id = id
        supportedCommands = RequestType.allCases.map(\.rawValue).sorted()
        supportedFeatures = RunnerFeature.allCases.map(\.rawValue).sorted()
    }
}
