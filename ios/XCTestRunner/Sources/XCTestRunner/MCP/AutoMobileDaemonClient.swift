import Foundation
import Network

/// MCP client over the daemon's Unix-domain socket (Network.framework `NWConnection`).
///
/// Concurrency (closes race #2): the reference ordered `connection`/`buffer`/`requestId` with the
/// per-request semaphores alone, so two threads calling `callTool`/`resetSession` on one client would
/// race. True queue-confinement is impossible here — the public methods block on semaphores waiting
/// for `NWConnection` callbacks dispatched to the *same* `queue`, so funneling the methods onto it
/// would deadlock. Instead `operationLock` serializes whole public operations: only the lock holder
/// (and, while it is blocked on a receive semaphore, that connection callback) touches the mutable
/// state, so cross-thread use is now safe. The lock is held across network I/O, so it is an `NSLock`
/// (not a short-critical-section unfair lock). `@unchecked Sendable` is justified by that serialization.
public final class AutoMobileDaemonClient: AutoMobileMCPClient, @unchecked Sendable {
    private let socketPath: String
    private let logger: AutoMobileLogger
    private let clientVersion: String
    private let queue = DispatchQueue(label: "AutoMobileDaemonClient")
    private let operationLock = NSLock()
    private var connection: NWConnection?
    private var buffer = Data()
    private var requestId: Int64 = 0

    public init(
        socketPath: String,
        logger: AutoMobileLogger = StdoutLogger(),
        clientVersion: String? = nil
    ) {
        self.socketPath = socketPath
        self.logger = logger
        self.clientVersion = clientVersion ?? DaemonManager.resolveDaemonClientVersion()
    }

    /// The frozen P0 daemon-socket `mcp_request` envelope plus its trailing `\n` framing, extracted
    /// (the reference built the dict inline) so the wire is unit-testable without a socket.
    static func encodeRequestLine(
        id: String,
        method: String,
        params: [String: Any],
        timeoutMs: Int,
        clientVersion: String
    ) -> Data? {
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

    public func initialize(timeout: TimeInterval) throws {
        operationLock.lock()
        defer { operationLock.unlock() }
        PerfTimer.log("DaemonClient.initialize START")
        try ensureConnection(timeout: timeout)
        PerfTimer.log("DaemonClient.initialize END")
    }

    public func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) throws -> MCPToolResponse {
        operationLock.lock()
        defer { operationLock.unlock() }
        PerfTimer.log("DaemonClient.callTool START: name=\(name)")
        let params: [String: Any] = [
            "name": name,
            "arguments": arguments,
        ]
        let result = try sendRequest(method: "tools/call", params: params, timeout: timeout)
        let text = try extractTextContent(from: result)
        PerfTimer.log("DaemonClient.callTool END: name=\(name), responseLength=\(text.count)")
        return MCPToolResponse(text: text)
    }

    public func readResource(uri: String, timeout: TimeInterval) throws -> MCPResourceResponse {
        operationLock.lock()
        defer { operationLock.unlock() }
        PerfTimer.log("DaemonClient.readResource START: uri=\(uri)")
        let params: [String: Any] = [
            "uri": uri,
        ]
        let result = try sendRequest(method: "resources/read", params: params, timeout: timeout)
        let text = try extractResourceTextContent(from: result)
        PerfTimer.log("DaemonClient.readResource END: uri=\(uri), responseLength=\(text.count)")
        return MCPResourceResponse(text: text)
    }

    public func resetSession() {
        operationLock.lock()
        defer { operationLock.unlock() }
        connection?.cancel()
        connection = nil
        buffer = Data()
    }

    private func ensureConnection(timeout: TimeInterval) throws {
        if connection != nil {
            PerfTimer.log("ensureConnection: already connected")
            return
        }

        PerfTimer.log("ensureConnection: creating NWConnection to \(socketPath)")
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        let semaphore = DispatchSemaphore(value: 0)
        let errorBox = ConnectionErrorBox()

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                PerfTimer.log("ensureConnection: NWConnection ready")
                semaphore.signal()
            case let .failed(error):
                PerfTimer.log("ensureConnection: NWConnection failed - \(error)")
                errorBox.error = error
                semaphore.signal()
            case .cancelled:
                PerfTimer.log("ensureConnection: NWConnection cancelled")
                errorBox.error = MCPClientError.requestFailed("Daemon connection cancelled")
                semaphore.signal()
            default:
                break
            }
        }

        PerfTimer.log("ensureConnection: starting connection")
        connection.start(queue: queue)
        let timeoutResult = semaphore.wait(timeout: .now() + timeout)
        if timeoutResult == .timedOut {
            PerfTimer.log("ensureConnection: TIMEOUT")
            connection.cancel()
            throw MCPClientError.requestFailed("Timed out connecting to daemon socket")
        }

        if let error = errorBox.error {
            connection.cancel()
            throw MCPClientError.requestFailed(error.localizedDescription)
        }

        PerfTimer.log("ensureConnection: connected successfully")
        self.connection = connection
    }

    private func sendRequest(method: String, params: [String: Any], timeout: TimeInterval) throws -> [String: Any] {
        PerfTimer.log("sendRequest START: method=\(method)")
        try ensureConnection(timeout: timeout)
        guard let connection = connection else {
            throw MCPClientError.requestFailed("Daemon connection unavailable")
        }

        requestId += 1
        guard let payload = Self.encodeRequestLine(
            id: "\(requestId)",
            method: method,
            params: params,
            timeoutMs: Int(timeout * 1000),
            clientVersion: clientVersion
        ) else {
            throw MCPClientError.requestFailed("Failed to encode daemon request")
        }
        PerfTimer.log("sendRequest: sending \(payload.count) bytes")

        let sendSemaphore = DispatchSemaphore(value: 0)
        let sendErrorBox = ConnectionErrorBox()
        connection.send(content: payload, completion: .contentProcessed { error in
            sendErrorBox.error = error
            sendSemaphore.signal()
        })

        let sendTimeout = sendSemaphore.wait(timeout: .now() + timeout)
        if sendTimeout == .timedOut {
            PerfTimer.log("sendRequest: TIMEOUT sending")
            throw MCPClientError.requestFailed("Timed out sending daemon request")
        }
        if let error = sendErrorBox.error {
            throw MCPClientError.requestFailed(error.localizedDescription)
        }
        PerfTimer.log("sendRequest: sent successfully, waiting for response")

        let responseData = try receiveLine(timeout: timeout)
        PerfTimer.log("sendRequest: received \(responseData.count) bytes")

        let jsonObject = try JSONSerialization.jsonObject(with: responseData, options: [])
        guard let response = jsonObject as? [String: Any] else {
            throw MCPClientError.invalidResponse("Expected JSON object response from daemon")
        }

        let success = response["success"] as? Bool ?? false
        if !success {
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

    private func receiveLine(timeout: TimeInterval) throws -> Data {
        guard let connection = connection else {
            throw MCPClientError.requestFailed("Daemon connection unavailable")
        }

        let semaphore = DispatchSemaphore(value: 0)
        let resultBox = ReceiveResultBox()
        // A private method (not a nested recursive local function) so the `@Sendable` receive
        // callback can re-arm itself without capturing a non-Sendable local closure under .v6.
        receiveChunk(on: connection, into: resultBox, signalling: semaphore)

        let waitResult = semaphore.wait(timeout: .now() + timeout)
        if waitResult == .timedOut {
            throw MCPClientError.requestFailed("Timed out waiting for daemon response")
        }
        if let error = resultBox.error {
            throw MCPClientError.requestFailed(error.localizedDescription)
        }
        guard let output = resultBox.output else {
            throw MCPClientError.invalidResponse("Daemon response missing data")
        }
        return output
    }

    private func receiveChunk(
        on connection: NWConnection,
        into resultBox: ReceiveResultBox,
        signalling semaphore: DispatchSemaphore
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if let data = data {
                buffer.append(data)
                if let lineRange = buffer.firstRange(of: Data([0x0A])) {
                    let lineData = buffer.subdata(in: 0 ..< lineRange.lowerBound)
                    buffer.removeSubrange(0 ... lineRange.lowerBound)
                    resultBox.output = lineData
                    semaphore.signal()
                    return
                }
            }

            if let error = error {
                resultBox.error = error
                semaphore.signal()
                return
            }

            if isComplete {
                resultBox.error = MCPClientError.requestFailed("Daemon connection closed")
                semaphore.signal()
                return
            }

            receiveChunk(on: connection, into: resultBox, signalling: semaphore)
        }
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

/// Thread-crossing error slot for an `NWConnection` callback. `@unchecked Sendable`: the callback
/// writes it before `signal()`, and the caller reads it only after a successful `wait()` — the
/// semaphore establishes the happens-before, exactly as the reference relied on.
private final class ConnectionErrorBox: @unchecked Sendable {
    var error: Error?
}

/// Thread-crossing result slot for the `NWConnection` receive callback (semaphore-ordered, as above).
private final class ReceiveResultBox: @unchecked Sendable {
    var output: Data?
    var error: Error?
}
