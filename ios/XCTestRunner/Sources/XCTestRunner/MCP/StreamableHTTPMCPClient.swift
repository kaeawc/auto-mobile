import Foundation
import os

/// MCP client over the StreamableHTTP transport (JSON-RPC 2.0). Concurrency (closes race #3): the
/// reference mutated `sessionId`/`requestId` on both the caller thread and the `URLSession` completion
/// thread, ordered only by the request semaphore. Here they are **lock-confined**
/// (`OSAllocatedUnfairLock`), so every read/write is atomic. `@unchecked Sendable` only because the
/// stored `URLSession` is not `Sendable` (it is documented thread-safe; used read-only after init).
public final class StreamableHTTPMCPClient: AutoMobileMCPClient, @unchecked Sendable {
    private struct State: Sendable {
        var sessionId: String?
        var requestId: Int64 = 0
    }

    private let state = OSAllocatedUnfairLock<State>(initialState: State())
    private let endpoint: URL
    private let logger: AutoMobileLogger
    private let session: URLSession

    public init(endpoint: URL, logger: AutoMobileLogger = StdoutLogger(), session: URLSession = .shared) throws {
        guard endpoint.scheme != nil else {
            throw MCPClientError.invalidEndpoint(endpoint.absoluteString)
        }
        self.endpoint = endpoint
        self.logger = logger
        self.session = session
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

    public func initialize(timeout: TimeInterval) throws {
        _ = try sendRequest(method: "initialize", params: Self.initializeParams(), timeout: timeout)
    }

    public func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) throws -> MCPToolResponse {
        if state.withLock({ $0.sessionId }) == nil {
            try initialize(timeout: timeout)
        }

        let params: [String: Any] = [
            "name": name,
            "arguments": arguments,
        ]

        do {
            let result = try sendRequest(method: "tools/call", params: params, timeout: timeout)
            let text = try extractTextContent(from: result)
            return MCPToolResponse(text: text)
        } catch let error as MCPClientError where error == .sessionExpired {
            resetSession()
            try initialize(timeout: timeout)
            let result = try sendRequest(method: "tools/call", params: params, timeout: timeout)
            let text = try extractTextContent(from: result)
            return MCPToolResponse(text: text)
        }
    }

    public func readResource(uri: String, timeout: TimeInterval) throws -> MCPResourceResponse {
        if state.withLock({ $0.sessionId }) == nil {
            try initialize(timeout: timeout)
        }

        let params: [String: Any] = [
            "uri": uri,
        ]

        do {
            let result = try sendRequest(method: "resources/read", params: params, timeout: timeout)
            let text = try extractResourceTextContent(from: result)
            return MCPResourceResponse(text: text)
        } catch let error as MCPClientError where error == .sessionExpired {
            resetSession()
            try initialize(timeout: timeout)
            let result = try sendRequest(method: "resources/read", params: params, timeout: timeout)
            let text = try extractResourceTextContent(from: result)
            return MCPResourceResponse(text: text)
        }
    }

    public func resetSession() {
        state.withLock { $0.sessionId = nil }
    }

    private func sendRequest(method: String, params: [String: Any], timeout: TimeInterval) throws -> [String: Any] {
        let id = state.withLock { current -> Int64 in
            current.requestId += 1
            return current.requestId
        }
        guard let data = Self.encodeJSONRPCBody(id: id, method: method, params: params) else {
            throw MCPClientError.requestFailed("Failed to encode MCP request")
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = data
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let sessionId = state.withLock({ $0.sessionId }) {
            request.setValue(sessionId, forHTTPHeaderField: "MCP-Session-Id")
        }

        let responseData = try performRequest(request: request, timeout: timeout)

        let jsonObject = try JSONSerialization.jsonObject(with: responseData, options: [])
        guard let response = jsonObject as? [String: Any] else {
            throw MCPClientError.invalidResponse("Expected JSON object response")
        }

        if let error = response["error"] as? [String: Any] {
            let message = error["message"] as? String ?? "Unknown MCP error"
            throw MCPClientError.serverError(message)
        }

        guard let result = response["result"] as? [String: Any] else {
            throw MCPClientError.invalidResponse("Missing result in MCP response")
        }
        return result
    }

    private func performRequest(request: URLRequest, timeout: TimeInterval) throws -> Data {
        let semaphore = DispatchSemaphore(value: 0)
        let box = HTTPResultBox()

        let task = session.dataTask(with: request) { [weak self] data, response, error in
            defer { semaphore.signal() }

            if let error = error {
                box.result = .failure(MCPClientError.requestFailed(error.localizedDescription))
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                box.result = .failure(MCPClientError.invalidResponse("Missing HTTP response"))
                return
            }

            if httpResponse.statusCode == 404 {
                box.result = .failure(MCPClientError.sessionExpired)
                return
            }

            if let self = self, let sessionHeader = Self.extractSessionId(from: httpResponse) {
                self.state.withLock { $0.sessionId = sessionHeader }
            }

            guard let data = data else {
                box.result = .failure(MCPClientError.invalidResponse("Empty response body"))
                return
            }
            box.result = .success(data)
        }
        task.resume()

        let timeoutResult = semaphore.wait(timeout: .now() + timeout + 1)
        if timeoutResult == .timedOut {
            task.cancel()
            throw MCPClientError.requestFailed("Request timed out")
        }

        switch box.result {
        case let .success(data):
            return data
        case let .failure(error):
            throw error
        case .none:
            throw MCPClientError.requestFailed("Request failed without response")
        }
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

/// Thread-crossing result slot for the `URLSession` completion handler. `@unchecked Sendable`: the
/// handler writes it before `signal()`, read only after a successful `wait()` — semaphore-ordered.
private final class HTTPResultBox: @unchecked Sendable {
    var result: Result<Data, Error>?
}
