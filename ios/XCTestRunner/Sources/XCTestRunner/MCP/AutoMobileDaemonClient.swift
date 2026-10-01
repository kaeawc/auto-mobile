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
    private let connectionFactory: DaemonLineConnectionFactory
    private let operationLock = NSLock()
    private var connection: DaemonLineConnection?
    private var requestId: Int64 = 0

    public convenience init(
        socketPath: String,
        logger: AutoMobileLogger = StdoutLogger(),
        clientVersion: String? = nil
    ) {
        self.init(
            socketPath: socketPath,
            logger: logger,
            clientVersion: clientVersion,
            connectionFactory: NWDaemonLineConnectionFactory()
        )
    }

    init(
        socketPath: String,
        logger: AutoMobileLogger = StdoutLogger(),
        clientVersion: String? = nil,
        connectionFactory: DaemonLineConnectionFactory
    ) {
        self.socketPath = socketPath
        self.logger = logger
        self.clientVersion = clientVersion ?? DaemonManager.resolveDaemonClientVersion()
        self.connectionFactory = connectionFactory
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
        dropConnection()
    }

    private func ensureConnection(timeout: TimeInterval) throws {
        if connection != nil {
            PerfTimer.log("ensureConnection: already connected")
            return
        }

        PerfTimer.log("ensureConnection: creating line connection to \(socketPath)")
        let connection = connectionFactory.makeConnection(socketPath: socketPath)
        do {
            try connection.connect(timeout: timeout)
            self.connection = connection
            PerfTimer.log("ensureConnection: connected successfully")
        } catch {
            connection.cancel()
            throw MCPClientError.requestFailed(error.localizedDescription)
        }
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

        do {
            try connection.sendLine(payload, timeout: timeout)
        } catch {
            dropConnection()
            throw MCPClientError.requestFailed(error.localizedDescription)
        }
        PerfTimer.log("sendRequest: sent successfully, waiting for response")

        let responseData = try receiveLine(expectedId: "\(requestId)", timeout: timeout)
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

    private func receiveLine(expectedId: String, timeout: TimeInterval) throws -> Data {
        guard let connection = connection else {
            throw MCPClientError.requestFailed("Daemon connection unavailable")
        }
        let deadline = Date().addingTimeInterval(timeout)
        do {
            while true {
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0 else {
                    throw MCPClientError.requestFailed("Timed out waiting for daemon response")
                }
                let line = try connection.receiveLine(timeout: remaining)
                let object = try JSONSerialization.jsonObject(with: line, options: [])
                guard let response = object as? [String: Any] else {
                    throw MCPClientError.invalidResponse("Expected JSON object response from daemon")
                }
                guard Self.jsonId(response["id"]) == expectedId else {
                    logger.info("Skipping daemon frame with non-matching id")
                    continue
                }
                return line
            }
        } catch {
            dropConnection()
            if let clientError = error as? MCPClientError {
                throw clientError
            }
            throw MCPClientError.requestFailed(error.localizedDescription)
        }
    }

    private static func jsonId(_ value: Any?) -> String? {
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        return nil
    }

    private func dropConnection() {
        connection?.cancel()
        connection = nil
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

protocol DaemonLineConnectionFactory {
    func makeConnection(socketPath: String) -> DaemonLineConnection
}

protocol DaemonLineConnection: AnyObject {
    func connect(timeout: TimeInterval) throws
    func sendLine(_ data: Data, timeout: TimeInterval) throws
    func receiveLine(timeout: TimeInterval) throws -> Data
    func cancel()
}

private struct NWDaemonLineConnectionFactory: DaemonLineConnectionFactory {
    func makeConnection(socketPath: String) -> DaemonLineConnection {
        NWDaemonLineConnection(socketPath: socketPath)
    }
}

private final class NWDaemonLineConnection: DaemonLineConnection, @unchecked Sendable {
    private let socketPath: String
    private let queue = DispatchQueue(label: "AutoMobileDaemonClient")
    private var connection: NWConnection?
    private var buffer = Data()

    init(socketPath: String) { self.socketPath = socketPath }

    func connect(timeout: TimeInterval) throws {
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        let semaphore = DispatchSemaphore(value: 0)
        let result = NWConnectionResult()
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready: semaphore.signal()
            case let .failed(error): result.error = error; semaphore.signal()
            case .cancelled: result.error = MCPClientError.requestFailed("Daemon connection cancelled"); semaphore
                .signal()
            default: break
            }
        }
        connection.start(queue: queue)
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            connection.cancel()
            throw MCPClientError.requestFailed("Timed out connecting to daemon socket")
        }
        if let error = result.error {
            connection.cancel()
            throw error
        }
        self.connection = connection
    }

    func sendLine(_ data: Data, timeout: TimeInterval) throws {
        guard let connection = connection else { throw MCPClientError.requestFailed("Daemon connection unavailable") }
        let semaphore = DispatchSemaphore(value: 0)
        let result = NWConnectionResult()
        connection.send(
            content: data,
            completion: .contentProcessed { error in result.error = error; semaphore.signal() }
        )
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw MCPClientError.requestFailed("Timed out sending daemon request")
        }
        if let error = result.error { throw error }
    }

    func receiveLine(timeout: TimeInterval) throws -> Data {
        guard let connection = connection else { throw MCPClientError.requestFailed("Daemon connection unavailable") }
        let semaphore = DispatchSemaphore(value: 0)
        let result = NWReceiveResult()
        receiveChunk(on: connection, result: result, semaphore: semaphore)
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw MCPClientError.requestFailed("Timed out waiting for daemon response")
        }
        if let error = result.error { throw error }
        guard let line = result.line else { throw MCPClientError.invalidResponse("Daemon response missing data") }
        return line
    }

    private func receiveChunk(on connection: NWConnection, result: NWReceiveResult, semaphore: DispatchSemaphore) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if let data {
                buffer.append(data)
                if let range = buffer.firstRange(of: Data([0x0A])) {
                    result.line = buffer.subdata(in: 0 ..< range.lowerBound)
                    buffer.removeSubrange(0 ... range.lowerBound)
                    semaphore.signal()
                    return
                }
            }
            if let error { result.error = error; semaphore.signal(); return }
            if isComplete {
                result.error = MCPClientError.requestFailed("Daemon connection closed"); semaphore.signal(); return
            }
            receiveChunk(on: connection, result: result, semaphore: semaphore)
        }
    }

    func cancel() {
        connection?.cancel()
        connection = nil
        buffer = Data()
    }
}

private final class NWConnectionResult: @unchecked Sendable {
    var error: Error?
}

private final class NWReceiveResult: @unchecked Sendable {
    var line: Data?
    var error: Error?
}
