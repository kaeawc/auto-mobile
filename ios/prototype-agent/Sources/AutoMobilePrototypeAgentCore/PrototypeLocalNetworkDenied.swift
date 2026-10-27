/// Permission not granted, kept typed across the connector boundary.
struct PrototypeLocalNetworkDenied: Error, Sendable {
    static let message =
        "Local network access was not granted for ProtoViewer. Allow it in Settings > Privacy & Security > Local Network, then turn network on again."
}
