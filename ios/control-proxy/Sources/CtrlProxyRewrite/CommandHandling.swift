import Foundation

/// Routes a decoded request to a typed, `Sendable`, encodable response. The server
/// depends on this seam (not the concrete `CommandHandler`, ported later) so the
/// networking core can be built and tested against a fake now.
///
/// Kept synchronous for the networking phase — matching the reference's flow, where
/// `handle` runs on the serial command queue. It becomes `async` when the real
/// `CommandHandler` and its `@MainActor` collaborators land, at which point the
/// server's command-queue dispatch is adjusted accordingly.
protocol CommandHandling: Sendable {
    func handle(_ request: WebSocketRequest) -> any WebSocketResponsePayload
}
