import Foundation

// The iOS ConnectedEvent initializer depends on its full CommandHandler. Keep this visionOS-only
// envelope local, with the same connected-event keys and the platform discriminator.
struct VisionConnectedEvent: Encodable, Sendable {
    let type = "connected"
    let id: Int
    let platform = "visionos"
    let supportedCommands = VisionCommandPolicy.supportedCommands
    let supportedFeatures: [String] = []
}
