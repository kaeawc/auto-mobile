import Foundation

/// Maps a caught error to the message surfaced on the WebSocket wire, and recovers
/// a request id from raw JSON for error correlation.
///
/// Ported verbatim from the reference target's `WebSocketServer` statics (only the
/// home changes: pure error-shaping logic, separated from the stateful server). The
/// exact strings are load-bearing and pinned by `TypedRequestDecodeTests`:
/// - `keyNotFound` + `CommandError.unknownCommand` pass through `localizedDescription`
///   unchanged (the latter matched by the TS `rewriteUnknownCommandError`).
/// - `typeMismatch` / `valueNotFound` / `dataCorrupted` are rewritten to actionable
///   text (#2965 / #2986).
enum WireError {
    /// Maps a caught error into the message surfaced on the wire.
    static func message(for error: Error) -> String {
        switch error {
        case let DecodingError.typeMismatch(_, context):
            if let field = fieldName(context) {
                return "Malformed request: wrong type for field '\(field)' (\(context.debugDescription))"
            }
            return "Malformed request: wrong type (\(context.debugDescription))"
        case let DecodingError.valueNotFound(_, context):
            if let field = fieldName(context) {
                return "Malformed request: missing value for field '\(field)' (\(context.debugDescription))"
            }
            return "Malformed request: missing value (\(context.debugDescription))"
        case let DecodingError.dataCorrupted(context):
            return dataCorruptedMessage(context)
        default:
            // keyNotFound + CommandError.unknownCommand + any other error: pass the
            // localizedDescription through unchanged (the contracts noted above).
            return error.localizedDescription
        }
    }

    /// Best-effort extraction of requestId from raw JSON data for error correlation.
    static func extractRequestId(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["requestId"] as? String
    }

    /// A human-readable name for the offending field, derived from the deepest
    /// `codingPath` key, or `nil` when the path is empty. A named leaf key is used
    /// verbatim; an array-index leaf is attributed to the nearest named ancestor with
    /// the index appended (`rules[0]`), or `[0]` if there is no named ancestor.
    private static func fieldName(_ context: DecodingError.Context) -> String? {
        let path = context.codingPath
        guard let last = path.last else {
            return nil
        }
        // Named leaf key — the common case (a wrong-typed field).
        if last.intValue == nil {
            return last.stringValue.isEmpty ? nil : last.stringValue
        }
        // The leaf is an array index — attribute to the nearest named ancestor.
        guard let index = last.intValue else {
            return nil
        }
        let parent = path.dropLast().last(where: { $0.intValue == nil })?.stringValue
        if let parent = parent, !parent.isEmpty {
            return "\(parent)[\(index)]"
        }
        return "[\(index)]"
    }

    /// Actionable message for a `DecodingError.dataCorrupted`. The overflow /
    /// malformed-JSON cases (empty `codingPath`, cause in the underlying Cocoa error)
    /// are the common ones; the final fallback attributes a field when a nested
    /// `dataCorrupted` carries a `codingPath` (#2986).
    private static func dataCorruptedMessage(_ context: DecodingError.Context) -> String {
        let underlyingDetail = (context.underlyingError as NSError?)?
            .userInfo[NSDebugDescriptionErrorKey] as? String

        if let detail = underlyingDetail, isNumberOutOfRangeDetail(detail) {
            return "Malformed request: a numeric value is out of range or not representable."
        }
        if let detail = underlyingDetail, !detail.isEmpty {
            // e.g. underlying "Unexpected character ',' around line 1, column 6."
            return "Malformed request: the payload is not valid JSON (\(detail))"
        }
        // No underlying detail — the decoder's own context description is still more
        // specific than the opaque localizedDescription; attribute the field when a
        // nested dataCorrupted carries one.
        if let field = fieldName(context) {
            return "Malformed request: field '\(field)' — \(context.debugDescription)"
        }
        return "Malformed request: \(context.debugDescription)"
    }

    /// Whether a Cocoa 3840 `NSDebugDescription` denotes an out-of-range /
    /// non-representable numeric literal (rather than a JSON syntax error). The exact
    /// phrasing differs by `JSONDecoder` backend:
    /// - swift-foundation (iOS 18+, macOS 15+): "Number 1e309 is not representable in Swift."
    /// - classic Foundation (iOS 15–17): "Number wound up as NaN around line 1, column 5."
    private static func isNumberOutOfRangeDetail(_ detail: String) -> Bool {
        detail.localizedCaseInsensitiveContains("not representable")
            || detail.localizedCaseInsensitiveContains("wound up as nan")
    }
}
