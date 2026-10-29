import Foundation

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
extension HingeAngleResponse: WebSocketResponsePayload {}
extension CurrentFocusResponse: WebSocketResponsePayload {}
extension TraversalOrderResponse: WebSocketResponsePayload {}
extension MagicTapResponse: WebSocketResponsePayload {}
extension SdkObservationResponse: WebSocketResponsePayload {}
extension SdkActionResponse: WebSocketResponsePayload {}
extension AccessibilityAuditResponse: WebSocketResponsePayload {}
extension SdkTriggerResponse: WebSocketResponsePayload {}
extension VoiceOverStateResponse: WebSocketResponsePayload {}
extension VoiceOverSetResponse: WebSocketResponsePayload {}
extension StorageFilesResponse: WebSocketResponsePayload {}
extension StorageEntriesResponse: WebSocketResponsePayload {}
extension StorageEntryResponse: WebSocketResponsePayload {}
extension SetNetworkMockRulesResponse: WebSocketResponsePayload {}
extension SetNetworkErrorSimulationResponse: WebSocketResponsePayload {}
extension SetNetworkFaultRulesResponse: WebSocketResponsePayload {}
extension SdkCapabilitiesResponse: WebSocketResponsePayload {}
extension ExecuteSqlResponse: WebSocketResponsePayload {}
extension ListDatabasesResponse: WebSocketResponsePayload {}
extension StorageCapabilitiesResponse: WebSocketResponsePayload {}
extension ListTablesResponse: WebSocketResponsePayload {}
extension TableDataResponse: WebSocketResponsePayload {}
extension TableStructureResponse: WebSocketResponsePayload {}
