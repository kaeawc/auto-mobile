import Foundation

// The iOS ConnectedEvent initializer depends on its full CommandHandler. Keep this tvOS-only
// envelope local, with the same connected-event keys and the platform discriminator.
struct TVConnectedEvent: Encodable, Sendable {
    let type = "connected"
    let id: Int
    let platform = "tvos"
    let supportedCommands = TVCommandPolicy.supportedCommands
    let supportedFeatures: [String] = []
}
