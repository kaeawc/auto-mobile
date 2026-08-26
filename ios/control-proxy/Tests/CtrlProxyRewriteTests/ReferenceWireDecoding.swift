import CtrlProxy
import CtrlProxyTestSupport
import Foundation

/// Decodes wire JSON through the REFERENCE `CtrlProxy` module.
///
/// This file imports only `CtrlProxy` (not `CtrlProxyRewrite`), so the bare
/// `WebSocketRequest` resolves unambiguously to the reference type — sidestepping
/// the `CtrlProxy` module-name / `CtrlProxy` type-name clash that makes
/// `CtrlProxy.WebSocketRequest` ambiguous in a file that imports both modules. The
/// return values are module-agnostic Foundation types, so the parity test can
/// compare reference and rewrite without ever naming either module's types.
enum ReferenceWireDecoder {
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
