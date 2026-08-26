@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE response-envelope models + error-response builder. Imports
/// only `CtrlProxy` (see `ReferenceWireDecoder`); `@testable` reaches the internal
/// `WebSocketServer.buildErrorResponseData`.
enum ReferenceResponses {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    static func connectedEventEncoded(id: Int) -> Data {
        (try? sortedEncoder().encode(ConnectedEvent(id: id))) ?? Data()
    }

    static func connectedSupportedCommands(id: Int) -> [String] {
        ConnectedEvent(id: id).supportedCommands
    }

    static func reencodeWebSocketResponse(_ data: Data) throws -> Data {
        try sortedEncoder().encode(JSONDecoder().decode(WebSocketResponse.self, from: data))
    }

    static func reencodeHierarchyUpdate(_ data: Data) throws -> Data {
        try sortedEncoder().encode(JSONDecoder().decode(HierarchyUpdateResponse.self, from: data))
    }

    static func buildErrorResponse(requestId: String?, error: Error) -> Data {
        WebSocketServer.buildErrorResponseData(requestId: requestId, error: error)
    }
}
