import Foundation
import os

/// StreamableHTTP JSON-RPC client. Short-held locks confine ids and session state; independent
/// requests may execute concurrently. Deadline losers never reach the session-header update.
public final class StreamableHTTPMCPClient: AutoMobileMCPClient, Sendable {
    private struct State: Sendable {
        var sessionId: String?
        var requestId: Int64 = 0
        var generation: UInt64 = 0
    }

    /// Internal injected seams keep the public URLSession initializer unchanged.
    struct Options: Sendable {
        var logger: any AutoMobileLogger = StdoutLogger()
        var scheduler: any DeadlineScheduler = SystemDeadlineScheduler()
    }

    private let state = OSAllocatedUnfairLock<State>(initialState: State())
    private let endpoint: URL
    private let logger: any AutoMobileLogger
    private let performer: any HTTPRequestPerforming
    private let scheduler: any DeadlineScheduler

    public convenience init(
        endpoint: URL,
        logger: AutoMobileLogger = StdoutLogger(),
        session: URLSession = .shared
    )
        throws
    {
        try self.init(
            endpoint: endpoint,
            performer: URLSessionRequestPerformer(session: session),
            options: Options(logger: logger)
        )
    }

    init(endpoint: URL, performer: any HTTPRequestPerforming, options: Options = Options()) throws {
        guard endpoint.scheme != nil else { throw MCPClientError.invalidEndpoint(endpoint.absoluteString) }
        self.endpoint = endpoint
        logger = options.logger
        self.performer = performer
        scheduler = options.scheduler
    }

    /// The frozen `initialize` params — `clientInfo.name` is a name-sensitive wire contract.
    static func initializeParams() -> [String: Any] {
        return [
            "protocolVersion": "2024-11-05",
            "capabilities": [:],
            "clientInfo": [
                "name": "auto-mobile-xctest-runner",
                "version": AutoMobileVersion.current,
            ],
        ]
    }

    /// The frozen JSON-RPC 2.0 request body, extracted so the wire is unit-testable.
    static func encodeJSONRPCBody(id: Int64, method: String, params: [String: Any]) -> Data? {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        ]
        return try? JSONSerialization.data(withJSONObject: payload, options: [])
    }

    /// Deprecated: use the async overload; the sync API will be removed in the next minor release (issue #6061).
    /// Only for synchronous XCTest threads, never the cooperative pool or @MainActor async code.
    /// The operation must not need the main actor; its own deadline bounds the blocking wait.
    public func initialize(timeout: TimeInterval) throws {
        try BlockingAsyncCall.run { try await self.initialize(timeout: timeout) }
    }

    /// Deprecated: use the async overload; the sync API will be removed in the next minor release (issue #6061).
    /// Only for synchronous XCTest threads, never the cooperative pool or @MainActor async code.
    /// The operation must not need the main actor; its own deadline bounds the blocking wait.
    public func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) throws -> MCPToolResponse {
        let params = try encodeParams(["name": name, "arguments": arguments])
        return try BlockingAsyncCall.run { try await self.callTool(params: params, timeout: timeout) }
    }

    /// Deprecated: use the async overload; the sync API will be removed in the next minor release (issue #6061).
    /// Only for synchronous XCTest threads, never the cooperative pool or @MainActor async code.
    /// The operation must not need the main actor; its own deadline bounds the blocking wait.
    public func readResource(uri: String, timeout: TimeInterval) throws -> MCPResourceResponse {
        try BlockingAsyncCall.run { try await self.readResource(uri: uri, timeout: timeout) }
    }

    public func initialize(timeout: TimeInterval) async throws {
        PerfTimer.log("HTTPClient.initialize START")
        _ = try await sendRequest(method: "initialize", params: encodeParams(Self.initializeParams()), timeout: timeout)
        PerfTimer.log("HTTPClient.initialize END")
    }

    public func callTool(
        name: String,
        arguments: [String: Any],
        timeout: TimeInterval
    )
        async throws -> MCPToolResponse
    {
        let params = try encodeParams(["name": name, "arguments": arguments])
        return try await callTool(params: params, timeout: timeout)
    }

    private func callTool(params: Data, timeout: TimeInterval) async throws -> MCPToolResponse {
        PerfTimer.log("HTTPClient.callTool START")
        let result = try await requestWithSession(method: "tools/call", params: params, timeout: timeout)
        let text = try extractTextContent(from: result)
        PerfTimer.log("HTTPClient.callTool END: responseLength=\(text.count)")
        return MCPToolResponse(text: text)
    }

    public func readResource(uri: String, timeout: TimeInterval) async throws -> MCPResourceResponse {
        let params = try encodeParams(["uri": uri])
        PerfTimer.log("HTTPClient.readResource START: uri=\(uri)")
        let result = try await requestWithSession(method: "resources/read", params: params, timeout: timeout)
        let text = try extractResourceTextContent(from: result)
        PerfTimer.log("HTTPClient.readResource END: responseLength=\(text.count)")
        return MCPResourceResponse(text: text)
    }

    private func requestWithSession(method: String, params: Data, timeout: TimeInterval) async throws -> [String: Any] {
        try Task.checkCancellation()
        if state.withLock({ $0.sessionId }) == nil { try await initialize(timeout: timeout) }
        do {
            return try await sendRequest(method: method, params: params, timeout: timeout)
        } catch let error as MCPClientError where error == .sessionExpired {
            resetSession()
            try await initialize(timeout: timeout)
            return try await sendRequest(method: method, params: params, timeout: timeout)
        }
    }

    public func resetSession() {
        state.withLock {
            $0.sessionId = nil
            $0.generation &+= 1
        }
    }

    private func encodeParams(_ params: [String: Any]) throws -> Data {
        // Foundation can raise an Objective-C exception for unsupported values, outside Swift's
        // throws mechanism. Validate first so encoding failure remains a recoverable client error.
        guard JSONSerialization.isValidJSONObject(params),
              let data = try? JSONSerialization.data(withJSONObject: params)
        else {
            throw MCPClientError.requestFailed("Failed to encode MCP request")
        }
        return data
    }

    private func sendRequest(method: String, params: Data, timeout: TimeInterval) async throws -> [String: Any] {
        try Task.checkCancellation()
        let snapshot = state.withLock { current in
            current.requestId += 1
            return (current.requestId, current.sessionId, current.generation)
        }
        let id = snapshot.0
        guard let params = try JSONSerialization.jsonObject(with: params) as? [String: Any],
              let data = Self.encodeJSONRPCBody(id: id, method: method, params: params)
        else { throw MCPClientError.requestFailed("Failed to encode MCP request") }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = data
        // URLSession's timeout and our cancellable deadline race at the same interval. Either winner
        // maps to requestFailed("Request timed out"); the former semaphore's +1 grace is unnecessary.
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let sessionId = snapshot.1 { request.setValue(sessionId, forHTTPHeaderField: "MCP-Session-Id") }
        let body = try await performRequest(request: request, timeout: timeout, generation: snapshot.2)
        let response = try Self.decodeResponse(body, id: id)
        if let error = response["error"] as? [String: Any] {
            throw MCPClientError.serverError(error["message"] as? String ?? "Unknown MCP error")
        }
        guard let result = response["result"] as? [String: Any] else {
            throw MCPClientError.invalidResponse("Missing result in MCP response")
        }
        return result
    }

    /// The response half of the transport this client advertises: every content type listed in the
    /// `Accept` header above has a decoder path here (#6633). The daemon builds its transport without
    /// `enableJsonResponse`, so the JSON-RPC response arrives as SSE frames; JSON stays supported in
    /// case a server opts into JSON mode.
    private static func decodeResponse(_ body: HTTPResponseBody, id: Int64) throws -> [String: Any] {
        guard isEventStream(body.contentType) else {
            return try decodeJSONObject(body.data)
        }
        return try decodeEventStream(body.data, id: id)
    }

    private static func isEventStream(_ contentType: String?) -> Bool {
        guard let contentType = contentType else {
            return false
        }
        return contentType.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("text/event-stream")
    }

    private static func decodeJSONObject(_ data: Data) throws -> [String: Any] {
        guard let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let response = object as? [String: Any]
        else {
            throw MCPClientError.invalidResponse("Expected JSON object response, got: \(bodyPreview(data))")
        }
        return response
    }

    /// Picks the frame whose JSON-RPC `id` matches the request just sent, so interleaved
    /// notifications and unrelated responses on the same stream are skipped. A frame carrying an
    /// `error` whose id is absent or null (JSON-RPC allows that on parse errors, which the server
    /// cannot attribute to a request) is the fallback, so such an error still surfaces as
    /// `serverError` rather than an opaque decode failure. Errors carrying another concrete id
    /// belong to a different request and are skipped.
    private static func decodeEventStream(_ data: Data, id: Int64) throws -> [String: Any] {
        var errorFrame: [String: Any]?
        for event in SSEEventParser.parse(data) {
            guard let payload = try? JSONSerialization.jsonObject(with: Data(event.data.utf8), options: []),
                  let object = payload as? [String: Any]
            else {
                continue
            }
            if matchesRequestId(object["id"], id: id) {
                return object
            }
            if errorFrame == nil, object["error"] != nil, isAbsentOrNullId(object["id"]) {
                errorFrame = object
            }
        }
        if let errorFrame = errorFrame {
            return errorFrame
        }
        throw MCPClientError.invalidResponse(
            "No SSE frame matched request id \(id), got: \(bodyPreview(data))"
        )
    }

    /// JSON-RPC allows a null (or, from some servers, omitted) id on errors the server could not
    /// attribute to a request — those are the only errors safe to adopt as this request's failure.
    /// An error carrying another concrete id belongs to a different request and is skipped.
    private static func isAbsentOrNullId(_ value: Any?) -> Bool {
        value == nil || value is NSNull
    }

    /// JSON-RPC ids are matched by type AND value, never by coercion. This client only ever sends
    /// integer ids, so a string `"1"`, a fractional `1.5` and a boolean `true` are all *different*
    /// ids from `1` — but Foundation bridges JSON booleans and fractions to `NSNumber`, whose
    /// `int64Value` flattens both to 1, and comparing a string id against `String(id)` equates two
    /// distinct JSON types. Either coercion adopts an interleaved frame that belongs to some other
    /// request as this request's response.
    private static func matchesRequestId(_ value: Any?, id: Int64) -> Bool {
        guard let number = value as? NSNumber, !isBoolean(number) else {
            return false
        }
        // NSNumber's own equality compares numeric values without truncating, so a fractional or
        // out-of-range id is a mismatch instead of being rounded into this request's id.
        return number == NSNumber(value: id)
    }

    /// `true`/`false` bridge to `NSNumber` (`kCFBooleanTrue`/`kCFBooleanFalse`) and compare equal to
    /// 1/0, so the JSON type has to be recovered through CoreFoundation.
    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID()
    }

    /// Bounded, single-line body excerpt for `invalidResponse` messages, per the structured-error
    /// convention — the raw Cocoa decoding error used to escape instead.
    private static func bodyPreview(_ data: Data, limit: Int = 200) -> String {
        let slice = data.prefix(limit)
        guard let text = String(data: slice, encoding: .utf8) else {
            return "<non-UTF8 body, \(data.count) bytes>"
        }
        let escaped = text
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\n", with: "\\n")
        return data.count > limit ? "\(escaped)…" : escaped
    }

    private func performRequest(
        request: URLRequest,
        timeout: TimeInterval,
        generation: UInt64
    )
        async throws -> HTTPResponseBody
    {
        let response: (Data, URLResponse)
        do {
            response = try await withDeadline(
                seconds: timeout, scheduler: scheduler,
                timeoutError: MCPClientError.requestFailed("Request timed out")
            ) {
                try Task.checkCancellation()
                return try await self.performer.perform(request)
            }
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            if let error = error as? MCPClientError { throw error }
            if let error = error as? URLError, error.code == .timedOut {
                throw MCPClientError.requestFailed("Request timed out")
            }
            throw MCPClientError.requestFailed(error.localizedDescription)
        }
        guard let httpResponse = response.1 as? HTTPURLResponse else {
            throw MCPClientError.invalidResponse("Missing HTTP response")
        }
        if httpResponse.statusCode == 404 { throw MCPClientError.sessionExpired }
        // This runs only for the winning response, never inside the deadline child. A reset also
        // invalidates the snapshot, so an older in-flight response cannot restore a cleared session.
        if let sessionHeader = Self.extractSessionId(from: httpResponse) {
            state.withLock { current in
                if current.generation == generation { current.sessionId = sessionHeader }
            }
        }
        return HTTPResponseBody(
            data: response.0, contentType: httpResponse.value(forHTTPHeaderField: "Content-Type")
        )
    }

    private static func extractSessionId(from response: HTTPURLResponse) -> String? {
        for (key, value) in response.allHeaderFields {
            let keyString = String(describing: key).lowercased()
            guard keyString == "mcp-session-id" else {
                continue
            }
            if let valueString = value as? String {
                return valueString
            }
        }
        return nil
    }

    private func extractTextContent(from result: [String: Any]) throws -> String {
        guard let content = result["content"] as? [[String: Any]] else {
            throw MCPClientError.invalidResponse("Missing content array")
        }
        for item in content {
            if let type = item["type"] as? String, type == "text",
               let text = item["text"] as? String
            {
                return text
            }
        }
        throw MCPClientError.invalidResponse("Missing text content")
    }

    private func extractResourceTextContent(from result: [String: Any]) throws -> String {
        guard let contents = result["contents"] as? [[String: Any]], let first = contents.first else {
            throw MCPClientError.invalidResponse("Missing resource contents")
        }
        if let text = first["text"] as? String {
            return text
        }
        throw MCPClientError.invalidResponse("Missing resource text content")
    }
}

/// A buffered HTTP response body plus the `Content-Type` that decides how to decode it.
struct HTTPResponseBody: Sendable {
    let data: Data
    let contentType: String?
}
