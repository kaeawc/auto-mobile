import Foundation

/// The lifecycle transitions `WebSocketConnection` reacts to, distilled from the
/// `NWConnection.State` cases it actually acts on (`.ready` starts the handshake
/// read; `.failed`/`.cancelled` fire the one-shot close). Modeling only these keeps
/// the test seam small while preserving the exact behavior.
enum ByteChannelState: Sendable {
    case ready
    case failed
    case cancelled
}
