import Foundation

/// The one-shot event pushed to a client on WebSocket upgrade. `supportedCommands`
/// (every `RequestType` raw value, sorted) is the ONLY runner-version signal the
/// daemon has — dropping/reordering/renaming a command breaks version-skew
/// detection, so its derivation from `RequestType.allCases` is load-bearing.
public struct ConnectedEvent: Codable, Sendable {
    public let type: String
    public let id: Int
    public let supportedCommands: [String]

    public init(id: Int) {
        type = "connected"
        self.id = id
        supportedCommands = RequestType.allCases.map(\.rawValue).sorted()
    }
}
