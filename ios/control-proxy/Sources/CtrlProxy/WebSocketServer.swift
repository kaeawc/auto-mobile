import Foundation
import Network

/// Global buffer for SDK events received via HTTP POST.
/// Shared across all WebSocketConnection instances.
public final class SdkEventBuffer {
    public static let shared = SdkEventBuffer()
    private let lock = NSLock()
    private var buffer: [Data] = []
    private let maxEvents = 500

    private init() {}

    public func append(_ data: Data) {
        lock.lock()
        buffer.append(data)
        while buffer.count > maxEvents { buffer.removeFirst() }
        lock.unlock()
    }

    public func drain() -> [Data] {
        lock.lock()
        let events = buffer
        buffer.removeAll()
        lock.unlock()
        return events
    }
}

/// WebSocket server for CtrlProxy iOS
/// Implements RFC 6455 WebSocket protocol over TCP
public class WebSocketServer: WebSocketServing {
    public enum ServerError: Error {
        case alreadyRunning
        case failedToStart(Error)
        case encodingError
    }

    private var listener: NWListener?
    private var connections: [Int: WebSocketConnection] = [:]
    private var nextConnectionId = 1
    private let port: UInt16
    private let commandHandler: CommandHandler
    private let perfProvider: PerfProvider
    private let sdkHierarchyCache: SdkHierarchyCache?
    private let queue = DispatchQueue(label: "com.ctrlproxy.server")

    public var isRunning: Bool {
        listener != nil
    }

    public init(
        port: UInt16 = 8765,
        commandHandler: CommandHandler,
        perfProvider: PerfProvider = PerfProvider.instance,
        sdkHierarchyCache: SdkHierarchyCache? = nil
    ) {
        self.port = port
        self.commandHandler = commandHandler
        self.perfProvider = perfProvider
        self.sdkHierarchyCache = sdkHierarchyCache
    }

    /// Starts the server
    public func start() throws {
        guard listener == nil else {
            throw ServerError.alreadyRunning
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true

        do {
            listener = try NWListener(using: parameters, on: NWEndpoint.Port(integerLiteral: port))
        } catch {
            throw ServerError.failedToStart(error)
        }

        listener?.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                break
            case let .failed(error):
                print("[WebSocketServer] Server failed: \(error)")
                self?.stop()
            case .cancelled:
                break
            default:
                break
            }
        }

        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleNewConnection(connection)
        }

        listener?.start(queue: queue)
    }

    /// Stops the server
    public func stop() {
        connections.values.forEach { $0.close() }
        connections.removeAll()
        listener?.cancel()
        listener = nil
    }

    // MARK: - Connection Handling

    private func handleNewConnection(_ nwConnection: NWConnection) {
        let connectionId = nextConnectionId
        nextConnectionId += 1

        let connection = WebSocketConnection(
            id: connectionId,
            connection: nwConnection,
            queue: queue,
            sdkHierarchyCache: sdkHierarchyCache
        ) { [weak self] message in
            self?.handleMessage(message, connectionId: connectionId)
        } onClose: { [weak self] in
            self?.connections.removeValue(forKey: connectionId)
        }

        connections[connectionId] = connection
        connection.start()
    }

    private func handleMessage(_ data: Data, connectionId: Int) {
        guard let connection = connections[connectionId] else { return }

        do {
            let request = try JSONDecoder().decode(WebSocketRequest.self, from: data)
            print("[WebSocketServer] Received request type=\(request.type) requestId=\(request.requestId ?? "nil")")

            // Track the entire request handling with PerfProvider
            perfProvider.serial("handleRequest:\(request.type)")
            let startTime = Date()

            let response = commandHandler.handle(request)
            let totalTimeMs = Int64(Date().timeIntervalSince(startTime) * 1000)

            perfProvider.end()

            // Flush perf timing data and encode response
            let perfTiming = flushPerfTiming()
            let responseData = try encodeResponse(response, totalTimeMs: totalTimeMs, perfTiming: perfTiming)
            connection.send(responseData)

        } catch {
            print("[WebSocketServer] Error handling message: \(error)")
            perfProvider.clear()
            let requestId = Self.extractRequestId(from: data)
            Self.sendErrorResponse(connection: connection, requestId: requestId, error: error)
        }
    }

    /// Flush accumulated perf timing data and return as a single PerfTiming entry
    private func flushPerfTiming() -> PerfTiming? {
        guard let timings = perfProvider.flush(), !timings.isEmpty else {
            return nil
        }

        // If there's only one entry, return it directly
        if timings.count == 1 {
            return timings[0]
        }

        // If multiple entries, wrap them in a parent
        let totalDuration = timings.reduce(0) { $0 + $1.durationMs }
        return PerfTiming(name: "total", durationMs: totalDuration, children: timings)
    }

    private func encodeResponse(_ response: Any, totalTimeMs: Int64, perfTiming: PerfTiming?) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys

        if var wsResponse = response as? WebSocketResponse {
            // Inject perfTiming if present and response doesn't already have it.
            // Preserve the existing `text` payload — handlers like `clipboard get`
            // populate it and we must not drop it during the rebuild.
            if perfTiming != nil && wsResponse.perfTiming == nil {
                wsResponse = WebSocketResponse(
                    type: wsResponse.type,
                    timestamp: wsResponse.timestamp,
                    requestId: wsResponse.requestId,
                    success: wsResponse.success,
                    totalTimeMs: wsResponse.totalTimeMs ?? totalTimeMs,
                    error: wsResponse.error,
                    text: wsResponse.text,
                    perfTiming: perfTiming
                )
            }
            return try encoder.encode(wsResponse)
        } else if var hierarchyResponse = response as? HierarchyUpdateResponse {
            // Inject perfTiming if present and response doesn't already have it
            if perfTiming != nil && hierarchyResponse.perfTiming == nil {
                hierarchyResponse = HierarchyUpdateResponse(
                    requestId: hierarchyResponse.requestId,
                    data: hierarchyResponse.data,
                    perfTiming: perfTiming,
                    error: hierarchyResponse.error
                )
            }
            return try encoder.encode(hierarchyResponse)
        } else if let screenshotResponse = response as? ScreenshotResponse {
            return try encoder.encode(screenshotResponse)
        } else if let encodable = response as? Encodable {
            return try encoder.encode(AnyEncodable(encodable))
        } else {
            throw ServerError.encodingError
        }
    }

    /// Broadcast a message to all connected clients
    public func broadcast(_ data: Data) {
        for connection in connections.values {
            connection.send(data)
        }
    }

    /// Broadcast a hierarchy update to all connected clients (push notification)
    public func broadcastHierarchyUpdate(_ hierarchy: ViewHierarchy) {
        let response = HierarchyUpdateResponse(
            requestId: nil, // No requestId for push updates
            data: hierarchy,
            perfTiming: nil
        )

        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let data = try encoder.encode(response)
            broadcast(data)
            print("[WebSocketServer] Broadcast hierarchy update to \(connections.count) client(s)")
        } catch {
            print("[WebSocketServer] Failed to encode hierarchy update: \(error)")
        }
    }

    /// Broadcast a performance update to all connected clients (push notification)
    public func broadcastPerformanceUpdate(_ snapshot: PerformanceSnapshot) {
        guard !connections.isEmpty else { return }

        let response = PerformanceUpdateResponse(data: snapshot)

        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let data = try encoder.encode(response)
            broadcast(data)
        } catch {
            print("[WebSocketServer] Failed to encode performance update: \(error)")
        }
    }

    /// Broadcast a message with perf timing data included.
    /// Flushes accumulated perf data and injects it into the message via the builder.
    /// - Parameter messageBuilder: Function that takes optional perfTiming and returns message data
    public func broadcastWithPerf(_ messageBuilder: (PerfTiming?) throws -> Data) rethrows {
        let perfTiming = flushPerfTiming()
        let data = try messageBuilder(perfTiming)
        broadcast(data)
    }

    /// Get access to the perf provider for tracking operations
    public var perf: PerfProvider {
        perfProvider
    }

    // MARK: - Error Response Helpers

    /// Sends an error response with fallback to raw JSON if encoding fails.
    static func sendErrorResponse(connection: WebSocketConnection, requestId: String?, error: Error) {
        let data = buildErrorResponseData(requestId: requestId, error: error)
        connection.send(data)
    }

    /// Builds error response data, falling back to hand-crafted JSON if encoding fails.
    static func buildErrorResponseData(requestId: String?, error: Error) -> Data {
        let errorResponse = WebSocketResponse.error(
            type: "error",
            requestId: requestId,
            error: error.localizedDescription
        )

        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
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
            print("[WebSocketServer] Error response encoding failed, using fallback")
            return fallbackJSON.data(using: .utf8) ?? Data()
        }
    }

    /// Best-effort extraction of requestId from raw JSON data for error correlation.
    private static func extractRequestId(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["requestId"] as? String
    }
}

// MARK: - WebSocket Connection

/// Handles a single WebSocket connection with handshake and framing
class WebSocketConnection {
    let id: Int
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let onMessage: (Data) -> Void
    private let onClose: () -> Void
    private let sdkHierarchyCache: (any SdkHierarchyCaching)?
    private var isWebSocketUpgraded = false

    init(
        id: Int,
        connection: NWConnection,
        queue: DispatchQueue,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        onMessage: @escaping (Data) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.id = id
        self.connection = connection
        self.queue = queue
        self.sdkHierarchyCache = sdkHierarchyCache
        self.onMessage = onMessage
        self.onClose = onClose
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.receiveHTTPUpgrade()
            case .failed, .cancelled:
                self?.onClose()
            default:
                break
            }
        }

        connection.start(queue: queue)
    }

    func close() {
        connection.cancel()
    }

    func send(_ data: Data) {
        let frame = createWebSocketFrame(data: data, opcode: 0x01) // Text frame
        connection.send(content: frame, completion: .contentProcessed { error in
            if let error = error {
                print("[WebSocketConnection] Send error: \(error)")
            }
        })
    }

    // MARK: - WebSocket Handshake

    private func receiveHTTPUpgrade() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_000_000) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }

            if let error = error {
                print("[WebSocketConnection] Error: \(error)")
                self.onClose()
                return
            }

            if isComplete {
                self.onClose()
                return
            }

            guard let data = data, let request = String(data: data, encoding: .utf8) else {
                self.receiveHTTPUpgrade()
                return
            }

            if request.contains("Upgrade: websocket") || request.contains("upgrade: websocket") {
                self.handleWebSocketUpgrade(request)
            } else if request.contains("GET /health") {
                self.handleHealthCheck()
            } else if request.contains("POST /sdk-events") {
                self.handleSdkEventsPost(request)
            } else if request.contains("GET /sdk-events") {
                self.handleSdkEventsGet()
            } else {
                // Not a WebSocket request, try again
                self.receiveHTTPUpgrade()
            }
        }
    }

    private func handleHealthCheck() {
        var payload: [String: String] = ["status": "ok"]
        if let deviceId = Self.currentDeviceId() {
            payload["deviceId"] = deviceId
        }

        let body = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
            ?? Data(#"{"status":"ok"}"#.utf8)
        let header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n"
        var response = Data(header.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { [weak self] _ in
            self?.connection.cancel()
        })
    }

    private static func currentDeviceId() -> String? {
        let environment = ProcessInfo.processInfo.environment
        return environment["AUTOMOBILE_DEVICE_ID"] ?? environment["SIMULATOR_UDID"]
    }

    private func handleSdkEventsPost(_ request: String) {
        // Extract body from after the header separator
        if let bodyRange = request.range(of: "\r\n\r\n") {
            let body = String(request[bodyRange.upperBound...])
            if let bodyData = body.data(using: .utf8), !bodyData.isEmpty {
                SdkEventBuffer.shared.append(bodyData)
                if let cache = sdkHierarchyCache {
                    SdkHierarchyExtractor.extractIfPresent(from: bodyData, into: cache)
                }
                print("[CtrlProxy] Received SDK event batch (\(bodyData.count) bytes)")
            } else {
                print("[CtrlProxy] POST /sdk-events: empty body after headers")
            }
        } else {
            print("[CtrlProxy] POST /sdk-events: no header separator found in \(request.count) chars")
        }
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"ok\":true}\r\n"
        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { [weak self] _ in
            self?.connection.cancel()
        })
    }

    private func handleSdkEventsGet() {
        // Merge SDK events with OSLogStore-captured log entries
        var allEvents = SdkEventBuffer.shared.drain()
        if #available(iOS 15.0, *) {
            let logEvents = OSLogReaderHolder.shared.drain()
            allEvents.append(contentsOf: logEvents)
        }
        let combined = "[" + allEvents.compactMap { String(data: $0, encoding: .utf8) }.joined(separator: ",") + "]"
        let bodyData = combined.data(using: .utf8) ?? Data()
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(bodyData.count)\r\n\r\n"
        var responseData = response.data(using: .utf8) ?? Data()
        responseData.append(bodyData)
        connection.send(content: responseData, completion: .contentProcessed { [weak self] _ in
            self?.connection.cancel()
        })
    }

    private func handleWebSocketUpgrade(_ request: String) {
        // Extract Sec-WebSocket-Key
        guard let keyLine = request.split(separator: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") }),
            let key = keyLine.split(separator: ":").last?.trimmingCharacters(in: .whitespaces)
        else {
            print("[WebSocketConnection] Missing Sec-WebSocket-Key")
            connection.cancel()
            return
        }

        // Calculate accept key
        let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let acceptKey = (key + magic).data(using: .utf8)!.sha1().base64EncodedString()

        // Send upgrade response
        let response = """
        HTTP/1.1 101 Switching Protocols\r
        Upgrade: websocket\r
        Connection: Upgrade\r
        Sec-WebSocket-Accept: \(acceptKey)\r
        \r

        """

        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { [weak self] error in
            if let error = error {
                print("[WebSocketConnection] Upgrade send error: \(error)")
                self?.onClose()
                return
            }

            self?.isWebSocketUpgraded = true
            self?.sendConnectedEvent()
            self?.receiveWebSocketFrame()
        })
    }

    private func sendConnectedEvent() {
        let event = ConnectedEvent(id: id)
        do {
            let data = try JSONEncoder().encode(event)
            send(data)
        } catch {
            let fallback = "{\"type\":\"connected\",\"id\":\(id)}"
            if let data = fallback.data(using: .utf8) {
                send(data)
            }
        }
    }

    // MARK: - WebSocket Frame Handling

    private func receiveWebSocketFrame() {
        // Read first 2 bytes (header)
        connection.receive(minimumIncompleteLength: 2, maximumLength: 2) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }

            if let error = error {
                print("[WebSocketConnection] Frame error: \(error)")
                self.onClose()
                return
            }

            if isComplete {
                self.onClose()
                return
            }

            guard let headerData = data, headerData.count == 2 else {
                self.receiveWebSocketFrame()
                return
            }

            self.parseWebSocketFrame(headerData)
        }
    }

    private func parseWebSocketFrame(_ header: Data) {
        let byte0 = header[0]
        let byte1 = header[1]

        let opcode = byte0 & 0x0F
        let isMasked = (byte1 & 0x80) != 0
        let payloadLength = UInt64(byte1 & 0x7F)

        // Handle close frame
        if opcode == 0x08 {
            sendCloseFrame()
            onClose()
            return
        }

        // Handle ping
        if opcode == 0x09 {
            // Send pong
            let pongFrame = createWebSocketFrame(data: Data(), opcode: 0x0A)
            connection.send(content: pongFrame, completion: .contentProcessed { _ in })
            receiveWebSocketFrame()
            return
        }

        // Read extended length if needed
        if payloadLength == 126 {
            readExtendedLength(2, isMasked: isMasked, opcode: opcode)
        } else if payloadLength == 127 {
            readExtendedLength(8, isMasked: isMasked, opcode: opcode)
        } else {
            readPayload(length: payloadLength, isMasked: isMasked, opcode: opcode)
        }
    }

    private func readExtendedLength(_ bytes: Int, isMasked: Bool, opcode: UInt8) {
        connection.receive(minimumIncompleteLength: bytes, maximumLength: bytes) { [weak self] data, _, _, _ in
            guard let self = self, let data = data else {
                self?.onClose()
                return
            }

            var length: UInt64 = 0
            for byte in data {
                length = length << 8 | UInt64(byte)
            }

            self.readPayload(length: length, isMasked: isMasked, opcode: opcode)
        }
    }

    private func readPayload(length: UInt64, isMasked: Bool, opcode: UInt8) {
        let maskLength = isMasked ? 4 : 0
        let totalLength = Int(length) + maskLength

        guard totalLength > 0 else {
            receiveWebSocketFrame()
            return
        }

        connection
            .receive(minimumIncompleteLength: totalLength, maximumLength: totalLength) { [weak self] data, _, _, _ in
                guard let self = self, let data = data else {
                    self?.onClose()
                    return
                }

                var payload: Data
                if isMasked {
                    let mask = Array(data.prefix(4))
                    let maskedData = data.suffix(from: 4)
                    var unmasked = Data()
                    for (i, byte) in maskedData.enumerated() {
                        unmasked.append(byte ^ mask[i % 4])
                    }
                    payload = unmasked
                } else {
                    payload = data
                }

                // Handle text or binary frame
                if opcode == 0x01 || opcode == 0x02 {
                    self.onMessage(payload)
                }

                self.receiveWebSocketFrame()
            }
    }

    private func createWebSocketFrame(data: Data, opcode: UInt8) -> Data {
        var frame = Data()

        // FIN + opcode
        frame.append(0x80 | opcode)

        // Payload length (server doesn't mask)
        if data.count < 126 {
            frame.append(UInt8(data.count))
        } else if data.count < 65536 {
            frame.append(126)
            frame.append(UInt8((data.count >> 8) & 0xFF))
            frame.append(UInt8(data.count & 0xFF))
        } else {
            frame.append(127)
            for i in (0 ..< 8).reversed() {
                frame.append(UInt8((data.count >> (i * 8)) & 0xFF))
            }
        }

        frame.append(data)
        return frame
    }

    private func sendCloseFrame() {
        let frame = createWebSocketFrame(data: Data(), opcode: 0x08)
        connection.send(content: frame, completion: .contentProcessed { _ in })
    }
}

// MARK: - SHA1 Extension

extension Data {
    func sha1() -> Data {
        var digest = [UInt8](repeating: 0, count: 20)
        _ = withUnsafeBytes { bytes in
            CC_SHA1(bytes.baseAddress, CC_LONG(self.count), &digest)
        }
        return Data(digest)
    }
}

// CommonCrypto import for SHA1
import CommonCrypto

// MARK: - AnyEncodable Helper

struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void

    init<T: Encodable>(_ wrapped: T) {
        _encode = wrapped.encode
    }

    func encode(to encoder: Encoder) throws {
        try _encode(encoder)
    }
}
