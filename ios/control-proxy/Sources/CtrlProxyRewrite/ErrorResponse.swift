import Foundation

/// Builds the error-response `Data` sent on the wire when a request fails to decode
/// or a command fails. Ported from the reference `WebSocketServer.buildErrorResponseData`.
///
/// Two deliberate differences from the reference, both parity-neutral:
/// - Uses a **fresh** `.sortedKeys` encoder per call rather than a shared static one
///   (the reference's shared `JSONEncoder` is a strict-concurrency smell; a per-call
///   encoder is Sendable-clean and byte-identical since the config matches).
/// - The error text comes from `WireError.message(for:)` (same mapping, new home).
///
/// The hand-crafted-JSON fallback for the (practically unreachable) encode-failure
/// path is preserved verbatim so a last-ditch error still reaches the client.
enum ErrorResponse {
    static func build(requestId: String?, error: Error) -> Data {
        let errorResponse = WebSocketResponse.error(
            type: "error",
            requestId: requestId,
            error: WireError.message(for: error)
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do {
            return try encoder.encode(errorResponse)
        } catch {
            let sanitizedError = String(
                errorResponse.error?
                    .prefix(500)
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    ?? "unknown error"
            )
            let requestIdJSON = requestId.map { id in
                let escaped = id
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                return "\"\(escaped)\""
            } ?? "null"
            let fallbackJSON = """
            {"type":"error","success":false,"requestId":\(requestIdJSON),"error":"[encoding fallback] \(sanitizedError)","timestamp":\(Int64(Date().timeIntervalSince1970 * 1000))}
            """
            return fallbackJSON.data(using: .utf8) ?? Data()
        }
    }
}
