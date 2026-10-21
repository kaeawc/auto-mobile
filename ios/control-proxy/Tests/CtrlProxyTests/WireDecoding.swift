import CtrlProxy
import CtrlProxyTestSupport
import Foundation

/// Decodes wire JSON through the `CtrlProxy` module for assertions against frozen wire fixtures.
enum WireDecoder {
    /// Returns the decoded command's discriminator and its Mirror-normalized payload.
    static func decode(_ data: Data) throws -> (type: String, normalizedPayload: Any) {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: data)
        return (request.typeString, jsonNormalized(request.payload))
    }

    /// The `errorDescription` produced when decoding fails, or nil on success.
    static func decodeErrorMessage(_ data: Data) -> String? {
        do {
            _ = try JSONDecoder().decode(WebSocketRequest.self, from: data)
            return nil
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}
