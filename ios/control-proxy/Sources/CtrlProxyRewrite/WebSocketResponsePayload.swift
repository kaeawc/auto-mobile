import Foundation

/// A command result that can be serialized onto the wire. Replaces the reference's
/// `CommandHandler.handle -> Any`: an `any WebSocketResponsePayload` is `Sendable`
/// (so it can cross the command queue → sender boundary under strict concurrency)
/// and `Encodable` (so the server can encode it), where `Any` was neither.
///
/// The `encoded(with:)` default has a concrete `Self`, so it sidesteps the
/// existential-opening dance the reference's `AnyEncodable` wrapper worked around.
/// The server still special-cases `WebSocketResponse` / `HierarchyUpdateResponse`
/// for `perfTiming` injection (see `WebSocketServer.encodeResponse`); every other
/// payload encodes straight through here.
///
/// Response types conform as they are ported; the CommandHandler-built envelopes
/// (Rotate/Keyboard/Storage/Sql/...) join in the CommandHandler phase.
protocol WebSocketResponsePayload: Sendable, Encodable {}

extension WebSocketResponsePayload {
    func encoded(with encoder: JSONEncoder) throws -> Data {
        try encoder.encode(self)
    }
}

extension WebSocketResponse: WebSocketResponsePayload {}
extension HierarchyUpdateResponse: WebSocketResponsePayload {}
