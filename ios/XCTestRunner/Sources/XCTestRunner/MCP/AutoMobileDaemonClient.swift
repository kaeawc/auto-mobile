import Foundation
import os

/// MCP over a Unix socket. The async gate preserves one request in flight while resetSession uses
/// only a short state lock, so teardown can interrupt I/O without waiting for the current holder.
public final class AutoMobileDaemonClient: AutoMobileMCPClient, Sendable {
    private struct State: Sendable {
        var connection: (any AsyncDaemonLineConnection)?
        var requestId: Int64 = 0
        var resetGeneration = 0
    }

    /// Groups internal seams instead of growing a long initializer; public construction is unchanged.
    struct Options: Sendable {
        var logger: any AutoMobileLogger = StdoutLogger()
        var clientVersion: String?
        var scheduler: any DeadlineScheduler = SystemDeadlineScheduler()
        var gate = AsyncSerialGate()
    }

    private let socketPath: String
    private let logger: any AutoMobileLogger
    private let clientVersion: String
    private let connectionFactory: any AsyncDaemonLineConnectionFactory
    private let scheduler: any DeadlineScheduler
    private let gate: AsyncSerialGate
    private let state = OSAllocatedUnfairLock(initialState: State())

    public convenience init(
        socketPath: String,
        logger: AutoMobileLogger = StdoutLogger(),
        clientVersion: String? = nil
    ) {
        self.init(
            socketPath: socketPath,
            connectionFactory: NWAsyncDaemonLineConnectionFactory(),
            options: Options(logger: logger, clientVersion: clientVersion)
        )
    }

    init(
        socketPath: String,
        connectionFactory: any AsyncDaemonLineConnectionFactory,
        options: Options = Options()
    ) {
        self.socketPath = socketPath
        logger = options.logger
        clientVersion = options.clientVersion ?? DaemonManager.resolveDaemonClientVersion()
        self.connectionFactory = connectionFactory
        scheduler = options.scheduler
        gate = options.gate
    }

    /// The frozen P0 daemon-socket `mcp_request` envelope plus its trailing `\n` framing, extracted
    /// (the reference built the dict inline) so the wire is unit-testable without a socket.
    static func encodeRequestLine(
        id: String,
        method: String,
        params: [String: Any],
        timeoutMs: Int,
        clientVersion: String
    )
        -> Data?
    {
        let request: [String: Any] = [
            "id": id,
            "type": "mcp_request",
            "method": method,
            "params": params,
            "timeoutMs": timeoutMs,
            // Declared for the daemon's server-side version handshake gate (#2744).
            "clientVersion": clientVersion,
        ]
        guard var payload = try? JSONSerialization.data(withJSONObject: request, options: []) else {
            return nil
        }
        payload.append(0x0A)
        return payload
    }

    public func initialize(timeout: TimeInterval) async throws {
        try await gate.acquire()
        defer { gate.release() }
        PerfTimer.log("DaemonClient.initialize START")
        let connection = currentConnection()
        do {
            try await withDeadline(
                seconds: timeout, scheduler: scheduler, onTimeout: { connection.cancel() },
                timeoutError: MCPClientError.requestFailed("Timed out connecting to daemon socket"),
                operation: { try await connection.connect(timeout: timeout) }
            )
            PerfTimer.log("DaemonClient.initialize END")
        } catch {
            dropConnection(connection)
            throw mapTransportError(error)
        }
    }

    public func callTool(
        name: String,
        arguments: [String: Any],
        timeout: TimeInterval
    )
        async throws -> MCPToolResponse
    {
        // Params cross the gate suspension as Data, not an untyped dictionary.
        let params = try encodeParams(["name": name, "arguments": arguments])
        return try await callTool(name: name, params: params, timeout: timeout)
    }

    private func callTool(name: String, params: Data, timeout: TimeInterval) async throws -> MCPToolResponse {
        PerfTimer.log("DaemonClient.callTool START: name=\(name)")
        let result = try await sendRequest(method: "tools/call", params: params, timeout: timeout)
        let text = try extractTextContent(from: result)
        PerfTimer.log("DaemonClient.callTool END: name=\(name), responseLength=\(text.count)")
        return MCPToolResponse(text: text)
    }

    public func readResource(uri: String, timeout: TimeInterval) async throws -> MCPResourceResponse {
        let params = try encodeParams(["uri": uri])
        PerfTimer.log("DaemonClient.readResource START: uri=\(uri)")
        let result = try await sendRequest(method: "resources/read", params: params, timeout: timeout)
        let text = try extractResourceTextContent(from: result)
        PerfTimer.log("DaemonClient.readResource END: uri=\(uri), responseLength=\(text.count)")
        return MCPResourceResponse(text: text)
    }

    public func resetSession() {
        let connection = state.withLock { current in
            current.resetGeneration += 1
            let connection = current.connection
            current.connection = nil
            return connection
        }
        connection?.cancel()
    }

    private func encodeParams(_ params: [String: Any]) throws -> Data {
        // Foundation can raise an Objective-C exception for unsupported values, outside Swift's
        // throws mechanism. Validate first so encoding failure remains a recoverable client error.
        guard JSONSerialization.isValidJSONObject(params),
              let data = try? JSONSerialization.data(withJSONObject: params)
        else {
            throw MCPClientError.requestFailed("Failed to encode daemon request")
        }
        return data
    }

    /// Factory creation does no I/O. Publishing before connect lets resetSession interrupt even the
    /// handshake; a failed/cancelled connection is removed before the gate passes to the next caller.
    private func currentConnection() -> any AsyncDaemonLineConnection {
        let snapshot = state.withLock { ($0.connection, $0.resetGeneration) }
        if let connection = snapshot.0 { return connection }
        // The gate serializes construction. An injected factory may signal continuation-backed
        // events, so invoke it outside the state lock that resetSession's cancellation path takes.
        let connection = connectionFactory.makeConnection(socketPath: socketPath)
        let published = state.withLock { current in
            guard current.resetGeneration == snapshot.1 else { return false }
            current.connection = connection
            return true
        }
        // Preserve reset's interrupt even if it arrived while construction ran outside the lock.
        if !published { connection.cancel() }
        return connection
    }

    private func dropConnection(_ connection: any AsyncDaemonLineConnection) {
        state.withLock { current in
            if current.connection === connection { current.connection = nil }
        }
        connection.cancel()
    }

    private func mapTransportError(_ error: any Error) -> any Error {
        if error is CancellationError { return error }
        if let error = error as? MCPClientError { return error }
        return MCPClientError.requestFailed(error.localizedDescription)
    }

    private func sendRequest(method: String, params: Data, timeout: TimeInterval) async throws -> [String: Any] {
        try await gate.acquire()
        defer { gate.release() }
        try Task.checkCancellation()
        // Assign ids in gate order; encode the entire frozen envelope before spawning deadline children.
        let id = state.withLock { current in
            current.requestId += 1
            return String(current.requestId)
        }
        guard let params = try JSONSerialization.jsonObject(with: params) as? [String: Any],
              let payload = Self.encodeRequestLine(
                  id: id, method: method, params: params,
                  timeoutMs: TimeoutConversion.milliseconds(forSeconds: timeout), clientVersion: clientVersion
              )
        else { throw MCPClientError.requestFailed("Failed to encode daemon request") }
        let connection = currentConnection()
        PerfTimer.log("sendRequest START: method=\(method)")
        let timeoutError = OSAllocatedUnfairLock(
            initialState:
            MCPClientError.requestFailed("Timed out connecting to daemon socket")
        )
        let responseData: Data
        do {
            responseData = try await withDeadline(
                seconds: timeout, scheduler: scheduler, onTimeout: { connection.cancel() },
                timeoutError: timeoutError.withLock { $0 },
                operation: {
                    try await withTaskCancellationHandler {
                        try Task.checkCancellation()
                        try await connection.connect(timeout: timeout)
                        try Task.checkCancellation()
                        timeoutError.withLock { $0 = .requestFailed("Timed out sending daemon request") }
                        PerfTimer.log("sendRequest: sending \(payload.count) bytes")
                        try await connection.sendLine(payload, timeout: timeout)
                        timeoutError.withLock { $0 = .requestFailed("Timed out waiting for daemon response") }
                        PerfTimer.log("sendRequest: sent successfully, waiting for response")
                        while true {
                            try Task.checkCancellation()
                            let line = try await connection.receiveLine(timeout: timeout)
                            let object = try JSONSerialization.jsonObject(with: line)
                            guard let response = object as? [String: Any] else {
                                throw MCPClientError.invalidResponse("Expected JSON object response from daemon")
                            }
                            guard Self.jsonId(response["id"]) == id else {
                                self.logger.info("Skipping daemon frame with non-matching id")
                                continue
                            }
                            return line
                        }
                    } onCancel: {
                        connection.cancel()
                    }
                }
            )
        } catch {
            dropConnection(connection)
            throw mapTransportError(error)
        }
        PerfTimer.log("sendRequest: received \(responseData.count) bytes")
        let jsonObject = try JSONSerialization.jsonObject(with: responseData)
        guard let response = jsonObject as? [String: Any] else {
            throw MCPClientError.invalidResponse("Expected JSON object response from daemon")
        }
        guard response["success"] as? Bool ?? false else {
            let message = response["error"] as? String ?? "Daemon returned error"
            PerfTimer.log("sendRequest ERROR: \(message)")
            throw MCPClientError.serverError(message)
        }
        guard let result = response["result"] as? [String: Any] else {
            throw MCPClientError.invalidResponse("Missing result in daemon response")
        }
        PerfTimer.log("sendRequest END: method=\(method)")
        return result
    }

    private static func jsonId(_ value: Any?) -> String? {
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
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
