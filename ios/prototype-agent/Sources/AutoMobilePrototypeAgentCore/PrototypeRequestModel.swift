import Foundation

// The `request` action (#12529, contract #12523): value types shared by the session, the driver
// and the HTTP clients. Nothing here touches the network or UIKit.

extension PrototypeLimits {
    /// `DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS`.
    static let defaultRequestTimeoutMs = 10000
    /// `MAX_PROTOTYPE_REQUEST_TIMEOUT_MS`: a larger `timeoutMs` fails validation; a host clamps.
    static let maxRequestTimeoutMs = 30000
    /// `MAX_PROTOTYPE_RESPONSE_BYTES`: never above `maxDataWriteBytes`, so any accepted response is one write.
    static let maxResponseBytes = 262_144
    /// `MAX_PROTOTYPE_REQUESTS_IN_FLIGHT`.
    static let maxRequestsInFlight = 4
    /// `MAX_PROTOTYPE_ACTION_DEPTH`: a top-level action is level 1; each `onSuccess` / `onError` adds one.
    static let maxActionDepth = 4
    /// The contract's `url` and event `url` bound.
    static let maxRequestURLLength = 2048
    /// The contract's `headers` / `query` entry count and entry string bound.
    static let maxRequestEntries = 16
    static let maxRequestEntryLength = 4096
    /// `onSuccess` / `onError` hold 1 to this many actions.
    static let maxFollowUpActions = 32
    /// The request event cuts `error.message` to this many characters.
    static let maxRequestMessageLength = 512
}

enum PrototypeRequestMethod: String, CaseIterable, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
    case head = "HEAD"

    /// GET and HEAD carry no body.
    var allowsBody: Bool { self != .get && self != .head }
}

enum PrototypeRequestVia: String, Sendable {
    case host
    case device
}

/// The `error.code` of a request's metadata and event: the host executor's transport codes plus
/// the two the response handling adds. Same strings as `PROTOTYPE_REQUEST_META_ERROR_CODES`.
enum PrototypeRequestErrorCode: String, CaseIterable, Sendable {
    case timeout
    case tooLarge = "too_large"
    case connectionRefused = "connection_refused"
    case cancelled
    case invalidURL = "invalid_url"
    case invalidRequest = "invalid_request"
    case network
    case tooManyInFlight = "too_many_in_flight"
    case httpError = "http_error"
    case invalidResponse = "invalid_response"
}

struct PrototypeRequestError: Error, Equatable, Sendable {
    let code: PrototypeRequestErrorCode
    let message: String

    init(_ code: PrototypeRequestErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }

    var json: JSONValue {
        .object(["code": .string(code.rawValue), "message": .string(message)])
    }
}

/// What came back for one request, from the host (`prototype_response`) or the on-device client.
enum PrototypeRequestResponse: Equatable, Sendable {
    /// `body` is the parsed JSON, else the raw string; `.null` for an empty body.
    case received(status: Int, headers: [String: String], body: JSONValue, durationMs: Int)
    case failed(PrototypeRequestError, durationMs: Int)
}

/// One request ready to run: every binding already resolved and the query merged into `url`.
struct PrototypeRequestJob: Equatable, Sendable {
    let requestId: String
    let prototypeId: String
    let via: PrototypeRequestVia
    let method: PrototypeRequestMethod
    let url: String
    let headers: [String: String]
    let body: JSONValue?
    /// As authored; nil means the default.
    let timeoutMs: Int?

    /// The deadline the call runs under.
    var effectiveTimeoutMs: Int {
        min(timeoutMs ?? PrototypeLimits.defaultRequestTimeoutMs, PrototypeLimits.maxRequestTimeoutMs)
    }

    /// The `prototype_request` frame (`prototypeRequestMessageSchema`) for a `via: "host"` call.
    var hostFrame: [String: Any] {
        var frame: [String: Any] = [
            "type": "prototype_request",
            "requestId": requestId,
            "prototypeId": prototypeId,
            "method": method.rawValue,
            "url": url,
        ]
        if !headers.isEmpty { frame["headers"] = headers }
        if let body { frame["body"] = body.foundationObject }
        if let timeoutMs { frame["timeoutMs"] = timeoutMs }
        return frame
    }
}

/// What the session asks its driver to do after a transition.
enum PrototypeRequestCommand: Equatable, Sendable {
    case start(PrototypeRequestJob)
    case cancel(requestId: String)
}

/// A started request the session is waiting on.
struct PrototypeInFlightRequest {
    let job: PrototypeRequestJob
    /// The bound `into` path, nil when the action has none.
    let into: String?
    let statusKey: String?
    let onSuccess: [PrototypeAction]
    let onError: [PrototypeAction]
}

/// The session's request bookkeeping: ids, who is waiting, and the commands for the driver.
struct PrototypeRequestLedger {
    /// Agent lifetime, so an id never repeats across shows.
    private var issued = 0
    private(set) var inFlight: [String: PrototypeInFlightRequest] = [:]
    private(set) var commands: [PrototypeRequestCommand] = []

    mutating func nextId() -> String {
        issued += 1
        return "r-\(issued)"
    }

    mutating func start(_ request: PrototypeInFlightRequest) {
        inFlight[request.job.requestId] = request
        commands.append(.start(request.job))
    }

    /// Removes a finished request; nil for one already cancelled or never started.
    mutating func finish(_ requestId: String) -> PrototypeInFlightRequest? {
        inFlight.removeValue(forKey: requestId)
    }

    mutating func cancel(_ requestId: String) {
        guard inFlight.removeValue(forKey: requestId) != nil else { return }
        commands.append(.cancel(requestId: requestId))
    }

    mutating func cancelAll() {
        for requestId in inFlight.keys.sorted() {
            cancel(requestId)
        }
    }

    mutating func takeCommands() -> [PrototypeRequestCommand] {
        defer { commands = [] }
        return commands
    }

    func inFlight(into: String) -> PrototypeInFlightRequest? {
        inFlight.values.first { $0.into == into }
    }
}

// MARK: Outcome

/// The `<into>__meta` value and what drives the status key and follow-up. The Swift twin of
/// `applyPrototypeRequestOutcome`'s `metaOf` (`prototypeRequestOutcome.ts`).
struct PrototypeRequestMeta: Equatable {
    var status: Int?
    var headers: [String: String]?
    var durationMs: Int
    var error: PrototypeRequestError?

    init(_ response: PrototypeRequestResponse) {
        switch response {
        case let .failed(error, durationMs):
            self.durationMs = durationMs
            self.error = error
        case let .received(status, headers, _, durationMs):
            self.status = status
            self.headers = headers
            self.durationMs = durationMs
            if !(200 ..< 300).contains(status) { error = PrototypeRequestError(.httpError, "HTTP \(status)") }
        }
    }

    /// `headers` is dropped when the whole value does not fit the `/data` write limit.
    func json(includingHeaders: Bool = true) -> JSONValue {
        var fields: [String: JSONValue] = ["durationMs": .number(Double(durationMs))]
        if let status { fields["status"] = .number(Double(status)) }
        if includingHeaders, let headers { fields["headers"] = .object(headers.mapValues(JSONValue.string)) }
        if let error { fields["error"] = error.json }
        return .object(fields)
    }
}

enum PrototypeRequestOutcome {
    /// The error when a body fits `/data` but not together with any form of its `__meta`.
    static let noRoomForMeta = "response and metadata exceed the data limit"

    /// What a 2xx response stores at `into`: JSON as it is, a string as it is, an empty body (and a
    /// HEAD) as `""`.
    static func storedBody(_ body: JSONValue, method: PrototypeRequestMethod) -> JSONValue {
        guard method != .head, body != .null else { return .string("") }
        return body
    }
}

// MARK: Event

enum PrototypeRequestEvent {
    /// The `emit` name a request completion is reported under; authored emits cannot use it.
    static let name = "prototype_request"

    /// The event payload (`PrototypeRequestEventPayload`): `url` is cut to 2048 characters and the
    /// error message to 512.
    static func payload(
        job: PrototypeRequestJob, into: String?, meta: PrototypeRequestMeta
    )
        -> JSONValue
    {
        var fields: [String: JSONValue] = [
            "requestId": .string(job.requestId),
            "method": .string(job.method.rawValue),
            "url": .string(cut(job.url, to: PrototypeLimits.maxRequestURLLength)),
            "via": .string(job.via.rawValue),
            "outcome": .string(meta.error == nil ? "success" : "error"),
            "durationMs": .number(Double(meta.durationMs)),
        ]
        if let into { fields["into"] = .string(into) }
        if let status = meta.status { fields["status"] = .number(Double(status)) }
        if let error = meta.error {
            fields["error"] = PrototypeRequestError(
                error.code, cut(error.message, to: PrototypeLimits.maxRequestMessageLength)
            ).json
        }
        return .object(fields)
    }

    /// At most `length` UTF-16 units, never splitting a character.
    static func cut(_ text: String, to length: Int) -> String {
        guard text.utf16.count > length else { return text }
        var out = String.UnicodeScalarView()
        var units = 0
        for scalar in text.unicodeScalars {
            units += scalar.value > 0xFFFF ? 2 : 1
            if units > length { break }
            out.append(scalar)
        }
        return String(out)
    }
}

// MARK: Wire

/// The host's `prototype_response` frame (`prototypeResponseMessageSchema`).
enum PrototypeRequestWire {
    static let responseType = "prototype_response"

    static func decodeResponse(_ frame: [String: Any]) -> (requestId: String, response: PrototypeRequestResponse)? {
        guard frame["type"] as? String == responseType, let requestId = frame["requestId"] as? String,
              let ok = frame["ok"] as? Bool else { return nil }
        let durationMs = Int(clamping: (frame["durationMs"] as? NSNumber)?.int64Value ?? 0)
        if ok {
            guard let status = (frame["status"] as? NSNumber)?.intValue else { return nil }
            let headers = (frame["headers"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
            let body = frame["body"].flatMap { json($0) } ?? .null
            return (requestId, .received(status: status, headers: headers, body: body, durationMs: max(0, durationMs)))
        }
        guard let error = frame["error"] as? [String: Any], let rawCode = error["code"] as? String,
              let message = error["message"] as? String else { return nil }
        // A code this agent does not know is still a failure; `network` keeps its message.
        let code = PrototypeRequestErrorCode(rawValue: rawCode) ?? .network
        return (requestId, .failed(PrototypeRequestError(code, message), durationMs: max(0, durationMs)))
    }

    /// A Foundation JSON value as `JSONValue`; nil when it is not JSON.
    static func json(_ value: Any) -> JSONValue? {
        if value is NSNull { return .null }
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}
