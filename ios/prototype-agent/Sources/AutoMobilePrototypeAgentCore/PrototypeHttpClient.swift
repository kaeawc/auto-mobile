import Foundation

// The on-device HTTP seam for `request` actions with `via: "device"` (#12529). Core knows only
// this protocol, so session and driver tests use a fake and Core links no HTTP library.
// `PrototypeURLSessionClient` is the URLSession implementation; an Alamofire one would be a second
// conformance behind the same protocol (see docs/design-docs/plat/ios/prototype-agent.md).

struct PrototypeHttpRequest: Equatable, Sendable {
    let method: PrototypeRequestMethod
    let url: String
    let headers: [String: String]
    let body: Data?
    /// Total time the call may take.
    let timeoutMs: Int
    /// The client stops reading, and fails with `too_large`, once a 2xx body crosses this. A non-2xx
    /// body is never read, so the cap does not apply to it.
    let maxResponseBytes: Int

    /// The call a job describes. A string body is sent as is with `Content-Type: text/plain;
    /// charset=utf-8`; any other JSON value is sent as JSON with `Content-Type: application/json`.
    /// An author-set content type (any letter case) wins in both cases. GET and HEAD send no body.
    init(job: PrototypeRequestJob, maxResponseBytes: Int = PrototypeLimits.maxResponseBytes) {
        method = job.method
        url = job.url
        timeoutMs = job.effectiveTimeoutMs
        self.maxResponseBytes = maxResponseBytes
        var headers = job.headers
        var body: Data?
        if let value = job.body, job.method.allowsBody {
            let hasContentType = headers.keys.contains { $0.lowercased() == "content-type" }
            if case let .string(text) = value {
                body = Data(text.utf8)
                if !hasContentType { headers["Content-Type"] = "text/plain; charset=utf-8" }
            } else {
                body = Data(PrototypeJSONText.string(value).utf8)
                if !hasContentType { headers["Content-Type"] = "application/json" }
            }
        }
        self.headers = headers
        self.body = body
    }
}

struct PrototypeHttpResponse: Equatable, Sendable {
    let status: Int
    /// Names lower-cased, as `<into>__meta` reports them.
    let headers: [String: String]
    let body: Data
    let durationMs: Int

    /// The response as the request contract carries it: parsed JSON, else the raw string, `.null`
    /// for an empty body and for a HEAD.
    func requestResponse(for method: PrototypeRequestMethod) -> PrototypeRequestResponse {
        .received(
            status: status,
            headers: headers,
            body: method == .head ? .null : PrototypeHttpBody.decode(body),
            durationMs: durationMs
        )
    }
}

/// A failed call: the typed error and how long it ran.
struct PrototypeHttpFailure: Error, Equatable, Sendable {
    let error: PrototypeRequestError
    let durationMs: Int
}

protocol PrototypeHttpClient: Sendable {
    /// Runs the call. Cancelling the calling task ends it with a `cancelled` failure. Throws
    /// `PrototypeHttpFailure` only.
    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse
}

enum PrototypeHttpBody {
    /// An empty body is `.null`; JSON is parsed; anything else is the (lossily decoded) text.
    static func decode(_ data: Data) -> JSONValue {
        guard !data.isEmpty else { return .null }
        if let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) { return parsed }
        return .string(String(decoding: data, as: UTF8.self))
    }
}

/// `JSON.stringify` for a `JSONValue`: numbers print as a script would (`1`, not `1.0`) and
/// slashes are not escaped.
enum PrototypeJSONText {
    static func string(_ value: JSONValue) -> String {
        switch value {
        case .null: "null"
        case let .bool(flag): flag ? "true" : "false"
        case let .number(number): number.isFinite ? PrototypeScalarText.jsonNumber(number) : "null"
        case let .string(text): quoted(text)
        case let .array(items): "[" + items.map(string).joined(separator: ",") + "]"
        case let .object(fields):
            "{" + fields.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) })
                .map { quoted($0) + ":" + string(fields[$0] ?? .null) }.joined(separator: ",") + "}"
        }
    }

    private static func quoted(_ text: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(text) else { return "\"\"" }
        return String(decoding: data, as: UTF8.self)
    }
}
