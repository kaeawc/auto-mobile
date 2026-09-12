import Foundation

/// Routes a decoded request to a typed, `Sendable`, encodable response. The server
/// depends on this seam (not the concrete `CommandHandler`, ported later) so the
/// networking core can be built and tested against a fake now.
///
/// `async` because the concrete `CommandHandler` `await`s its `@MainActor` UI collaborators
/// (`ElementLocator`, `GesturePerformer`) and its off-main async SDK clients. The server
/// runs it on a serial task-chain (see `WebSocketServer.dispatchCommand`) so per-connection
/// command ordering is preserved even though execution is no longer synchronous.
protocol CommandHandling: Sendable {
    func handle(_ request: WebSocketRequest) async -> any WebSocketResponsePayload
}
