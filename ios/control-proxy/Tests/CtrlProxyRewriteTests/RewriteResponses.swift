@testable import CtrlProxyRewrite
import Foundation

/// Drives the `CtrlProxyRewrite` response-envelope models + `ErrorResponse.build`
/// (see `ReferenceResponses`). `@testable` reaches the internal `ErrorResponse`.
enum RewriteResponses {
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
        ErrorResponse.build(requestId: requestId, error: error)
    }
}
