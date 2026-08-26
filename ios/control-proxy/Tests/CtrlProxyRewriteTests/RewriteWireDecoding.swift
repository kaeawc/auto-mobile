import CtrlProxyRewrite
import CtrlProxyTestSupport
import Foundation

/// Decodes wire JSON through the `CtrlProxyRewrite` module. Imports only the
/// rewrite (see `ReferenceWireDecoder` for why the split is necessary).
enum RewriteWireDecoder {
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
