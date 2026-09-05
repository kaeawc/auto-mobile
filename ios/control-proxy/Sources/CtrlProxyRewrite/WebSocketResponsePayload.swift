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
/// Every envelope `CommandHandler.handle` can return conforms below. `WebSocketResponse`
/// and `HierarchyUpdateResponse` are special-cased in `encodeResponse` for `perfTiming`
/// injection; the rest encode straight through.
protocol WebSocketResponsePayload: Sendable, Encodable {}

extension WebSocketResponsePayload {
    func encoded(with encoder: JSONEncoder) throws -> Data {
        try encoder.encode(self)
    }
}

// perfTiming-injection special cases (see WebSocketServer.encodeResponse).
extension WebSocketResponse: WebSocketResponsePayload {}
extension HierarchyUpdateResponse: WebSocketResponsePayload {}

// Straight-through envelopes built by CommandHandler.
extension ScreenshotResponse: WebSocketResponsePayload {}
extension KeyboardResponse: WebSocketResponsePayload {}
extension RotateResponse: WebSocketResponsePayload {}
extension CurrentFocusResponse: WebSocketResponsePayload {}
extension TraversalOrderResponse: WebSocketResponsePayload {}
extension VoiceOverStateResponse: WebSocketResponsePayload {}
extension VoiceOverSetResponse: WebSocketResponsePayload {}
extension StorageFilesResponse: WebSocketResponsePayload {}
extension StorageEntriesResponse: WebSocketResponsePayload {}
extension StorageEntryResponse: WebSocketResponsePayload {}
extension SetNetworkMockRulesResponse: WebSocketResponsePayload {}
extension SetNetworkErrorSimulationResponse: WebSocketResponsePayload {}
extension SetNetworkFaultRulesResponse: WebSocketResponsePayload {}
extension ExecuteSqlResponse: WebSocketResponsePayload {}
extension ListDatabasesResponse: WebSocketResponsePayload {}
extension StorageCapabilitiesResponse: WebSocketResponsePayload {}
extension ListTablesResponse: WebSocketResponsePayload {}
extension TableDataResponse: WebSocketResponsePayload {}
extension TableStructureResponse: WebSocketResponsePayload {}
