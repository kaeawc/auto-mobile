import Foundation
import Network

/// Handles a single WebSocket connection: HTTP upgrade handshake, HTTP endpoints
/// (`/health`, `/sdk-events`), and RFC-6455 frame read/reassembly.
///
/// Rewrite archetype: QUEUE-CONFINEMENT. `final class … @unchecked Sendable` owning
/// no queue of its own but bound to the server's serial `queue` (Network.framework
/// delivers every state/receive/send completion there). All mutable state
/// (`inboundBuffer`, `fragmentedOpcode`, `fragmentBuffer`, `didFireClose`,
/// `isWebSocketUpgraded`) is confined to that queue; each on-queue method asserts
/// `dispatchPrecondition(.onQueue(queue))`, turning the reference's prose invariant
/// into an enforced one (the `@unchecked` is justified by that confinement, not a
/// lock). `send(_:)` is the sole exception — it is called from any queue and is a
/// thread-safe passthrough that touches no confined state.
///
/// The SDK-hierarchy extraction and OSLog drain the reference did inline are seamed
/// out to injected `@Sendable` hooks (`onSdkEventBatch`, `drainLogEvents`), filled in
/// by the SDK/OSLog phase; the connection itself has no SDK/OSLog dependency.
final class WebSocketConnection: WebSocketResponding, @unchecked Sendable {
    let id: Int
    private let channel: ByteChannel
    private let queue: DispatchQueue
    private let onMessage: @Sendable (Data) -> Void
    private let onClose: @Sendable () -> Void
    private let onUpgrade: (@Sendable () -> Void)?
    /// Called with the raw `POST /sdk-events` body after it is appended to the
    /// shared event buffer, so the SDK-hierarchy extraction (which needs the cache)
    /// can run without this connection depending on it. Filled in the SDK phase.
    private let onSdkEventBatch: (@Sendable (Data) -> Void)?
    /// Supplies OSLog-captured entries to merge into `GET /sdk-events`. Filled in the
    /// OSLog phase; nil means "no log events" (the OSLog-unavailable path).
    private let drainLogEvents: (@Sendable () -> [Data])?
    /// The port the server is bound to; echoed in /health so the daemon can detect a
    /// runner/client port mismatch (issue #2735).
    private let boundPort: UInt16

    private var isWebSocketUpgraded = false
    /// Single per-connection inbound byte buffer drained by both the handshake
    /// reader and the frame reader; residual bytes after the handshake slice (e.g. a
    /// frame pipelined in the same TCP segment) stay here for the frame parser
    /// (issue #5678). Queue-confined.
    private var inboundBuffer = Data()
    /// In-progress fragmented-message reassembly state (RFC 6455 §5.4). Queue-confined.
    private var fragmentedOpcode: UInt8?
    private var fragmentBuffer = Data()
    /// Whether `onClose` has fired; collapses a `.failed`-then-`.cancelled` pair into
    /// one `onClose` (issue #5677). Queue-confined.
    private var didFireClose = false

    private static let maximumHTTPRequestLength = 1_000_000

    /// Designated initializer over the `ByteChannel` seam.
    init(
        id: Int,
        channel: ByteChannel,
        queue: DispatchQueue,
        boundPort: UInt16,
        onSdkEventBatch: (@Sendable (Data) -> Void)? = nil,
        drainLogEvents: (@Sendable () -> [Data])? = nil,
        onUpgrade: (@Sendable () -> Void)? = nil,
        onMessage: @escaping @Sendable (Data) -> Void,
        onClose: @escaping @Sendable () -> Void
    ) {
        self.id = id
        self.channel = channel
        self.queue = queue
        self.boundPort = boundPort
        self.onSdkEventBatch = onSdkEventBatch
        self.drainLogEvents = drainLogEvents
        self.onUpgrade = onUpgrade
        self.onMessage = onMessage
        self.onClose = onClose
    }

    /// Production convenience initializer: wraps a real `NWConnection`.
    convenience init(
        id: Int,
        connection: NWConnection,
        queue: DispatchQueue,
        boundPort: UInt16,
        onSdkEventBatch: (@Sendable (Data) -> Void)? = nil,
        drainLogEvents: (@Sendable () -> [Data])? = nil,
        onUpgrade: (@Sendable () -> Void)? = nil,
        onMessage: @escaping @Sendable (Data) -> Void,
        onClose: @escaping @Sendable () -> Void
    ) {
        self.init(
            id: id,
            channel: NWByteChannel(connection),
            queue: queue,
            boundPort: boundPort,
            onSdkEventBatch: onSdkEventBatch,
            drainLogEvents: drainLogEvents,
            onUpgrade: onUpgrade,
            onMessage: onMessage,
            onClose: onClose
        )
    }

    func start() {
        channel.onState = { [weak self] state in
            switch state {
            case .ready:
                self?.receiveHTTPUpgrade()
            case .failed, .cancelled:
                self?.fireOnClose()
            }
        }
        channel.start(queue: queue)
    }

    func close() {
        channel.cancel()
    }

    /// Tears the socket down on an error/close path by cancelling the channel; the
    /// `.cancelled` transition then fires `onClose` exactly once via `fireOnClose()`
    /// (issue #5677). Runs on `queue`.
    private func closeConnection() {
        dispatchPrecondition(condition: .onQueue(queue))
        channel.cancel()
    }

    /// Invokes `onClose` at most once. Called only from the `.failed`/`.cancelled`
    /// state handler (issue #5677 AC2). Runs on `queue`.
    func fireOnClose() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !didFireClose else { return }
        didFireClose = true
        onClose()
    }

    /// Sends one text frame. Callable from ANY queue (broadcast/command reply) — a
    /// thread-safe passthrough that touches no confined state, so no precondition.
    func send(_ data: Data) {
        let frame = WebSocketFraming.createWebSocketFrame(data: data, opcode: 0x01)
        channel.send(frame) { error in
            if let error = error {
                print("[WebSocketConnection] Send error: \(error)")
            }
        }
    }

    // MARK: - HTTP handshake / endpoints

    private func receiveHTTPUpgrade() {
        channel.receive(minimumIncompleteLength: 1, maximumLength: Self.maximumHTTPRequestLength) { [weak self] data, isComplete, error in
            guard let self = self else { return }
            dispatchPrecondition(condition: .onQueue(self.queue))

            if let error = error {
                print("[WebSocketConnection] Error: \(error)")
                self.closeConnection()
                return
            }
            if isComplete {
                self.closeConnection()
                return
            }
            guard let data = data else {
                self.receiveHTTPUpgrade()
                return
            }

            self.inboundBuffer.append(data)
            guard self.inboundBuffer.count <= Self.maximumHTTPRequestLength else {
                print("[WebSocketConnection] HTTP request exceeds maximum length")
                self.channel.cancel()
                return
            }

            guard let requestLength = WebSocketFraming.completeHTTPRequestLength(in: self.inboundBuffer) else {
                self.receiveHTTPUpgrade()
                return
            }

            let requestData = Data(self.inboundBuffer.prefix(requestLength))
            self.inboundBuffer.removeFirst(requestLength)
            guard let request = String(data: requestData, encoding: .utf8) else {
                self.channel.cancel()
                return
            }

            // Only the WebSocket-upgrade branch consumes bytes left in inboundBuffer
            // after the slice (a frame pipelined with the upgrade request, #5678); the
            // HTTP branches send-then-cancel, discarding any residual (AC4).
            if request.contains("Upgrade: websocket") || request.contains("upgrade: websocket") {
                self.handleWebSocketUpgrade(request)
            } else if request.contains("GET /health") {
                self.handleHealthCheck()
            } else if request.contains("POST /sdk-events") {
                self.handleSdkEventsPost(request)
            } else if request.contains("GET /sdk-events") {
                self.handleSdkEventsGet()
            } else {
                self.receiveHTTPUpgrade()
            }
        }
    }

    private func handleHealthCheck() {
        dispatchPrecondition(condition: .onQueue(queue))
        var payload: [String: Any] = ["status": "ok", "port": Int(boundPort)]
        if let deviceId = Self.currentDeviceId() {
            payload["deviceId"] = deviceId
        }
        let body = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
            ?? Data(#"{"status":"ok"}"#.utf8)
        let header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n"
        var response = Data(header.utf8)
        response.append(body)
        channel.send(response) { [weak self] _ in
            self?.channel.cancel()
        }
    }

    private static func currentDeviceId() -> String? {
        let environment = ProcessInfo.processInfo.environment
        return environment["AUTOMOBILE_DEVICE_ID"] ?? environment["SIMULATOR_UDID"]
    }

    private func handleSdkEventsPost(_ request: String) {
        dispatchPrecondition(condition: .onQueue(queue))
        if let bodyRange = request.range(of: "\r\n\r\n") {
            let body = String(request[bodyRange.upperBound...])
            if let bodyData = body.data(using: .utf8), !bodyData.isEmpty {
                SdkEventBuffer.shared.append(bodyData)
                onSdkEventBatch?(bodyData)
                print("[CtrlProxy] Received SDK event batch (\(bodyData.count) bytes)")
            } else {
                print("[CtrlProxy] POST /sdk-events: empty body after headers")
            }
        } else {
            print("[CtrlProxy] POST /sdk-events: no header separator found in \(request.count) chars")
        }
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"ok\":true}\r\n"
        channel.send(Data(response.utf8)) { [weak self] _ in
            self?.channel.cancel()
        }
    }

    private func handleSdkEventsGet() {
        dispatchPrecondition(condition: .onQueue(queue))
        var allEvents = SdkEventBuffer.shared.drain()
        if let logEvents = drainLogEvents?() {
            allEvents.append(contentsOf: logEvents)
        }
        let combined = "[" + allEvents.compactMap { String(data: $0, encoding: .utf8) }.joined(separator: ",") + "]"
        let bodyData = combined.data(using: .utf8) ?? Data()
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(bodyData.count)\r\n\r\n"
        var responseData = response.data(using: .utf8) ?? Data()
        responseData.append(bodyData)
        channel.send(responseData) { [weak self] _ in
            self?.channel.cancel()
        }
    }

    private func handleWebSocketUpgrade(_ request: String) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let keyLine = request.split(separator: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") }),
            let key = keyLine.split(separator: ":").last?.trimmingCharacters(in: .whitespaces)
        else {
            print("[WebSocketConnection] Missing Sec-WebSocket-Key")
            channel.cancel()
            return
        }

        let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        // A String always encodes to UTF-8, so .data(using: .utf8) is never nil.
        let acceptKey = (key + magic).data(using: .utf8)!.sha1().base64EncodedString() // swiftlint:disable:this force_unwrapping

        let response = """
        HTTP/1.1 101 Switching Protocols\r
        Upgrade: websocket\r
        Connection: Upgrade\r
        Sec-WebSocket-Accept: \(acceptKey)\r
        \r

        """

        channel.send(Data(response.utf8)) { [weak self] error in
            guard let self = self else { return }
            dispatchPrecondition(condition: .onQueue(self.queue))
            if let error = error {
                print("[WebSocketConnection] Upgrade send error: \(error)")
                self.closeConnection()
                return
            }
            self.isWebSocketUpgraded = true
            self.onUpgrade?()
            self.sendConnectedEvent()
            self.receiveWebSocketFrame()
        }
    }

    private func sendConnectedEvent() {
        dispatchPrecondition(condition: .onQueue(queue))
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

    // MARK: - WebSocket frame handling

    /// Reads exactly `count` bytes for the frame parser, draining `inboundBuffer`
    /// first (so a frame pipelined with the handshake is parsed, #5678) and refilling
    /// from the socket only for the shortfall. The buffered fast-path trampolines
    /// `onData` onto `queue` to bound recursion depth when many frames are buffered
    /// together. All completions run on `queue`. On socket error/EOF the connection
    /// is closed and `onData` is not called.
    private func receiveFrameBytes(_ count: Int, onData: @escaping @Sendable (Data) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        if inboundBuffer.count >= count {
            let chunk = Data(inboundBuffer.prefix(count))
            inboundBuffer.removeFirst(count)
            queue.async { onData(chunk) }
            return
        }

        let needed = count - inboundBuffer.count
        channel.receive(minimumIncompleteLength: needed, maximumLength: needed) { [weak self] data, isComplete, error in
            guard let self = self else { return }
            dispatchPrecondition(condition: .onQueue(self.queue))

            if let error = error {
                print("[WebSocketConnection] Frame error: \(error)")
                self.closeConnection()
                return
            }

            // Fast path: nothing buffered and the socket delivered the whole read in
            // one piece — hand it straight to `onData` without copying through
            // `inboundBuffer` (avoids a full-payload copy on the hot path, #5678).
            if self.inboundBuffer.isEmpty, let data = data, data.count == count {
                onData(data)
                return
            }

            if let data = data, !data.isEmpty {
                self.inboundBuffer.append(data)
            }

            if self.inboundBuffer.count >= count {
                let chunk = Data(self.inboundBuffer.prefix(count))
                self.inboundBuffer.removeFirst(count)
                onData(chunk)
                return
            }

            // Still short of a full frame. EOF here means the peer closed mid-frame.
            if isComplete {
                self.closeConnection()
                return
            }
            self.receiveFrameBytes(count, onData: onData)
        }
    }

    private func receiveWebSocketFrame() {
        dispatchPrecondition(condition: .onQueue(queue))
        receiveFrameBytes(2) { [weak self] headerData in
            self?.parseWebSocketFrame(headerData)
        }
    }

    private func parseWebSocketFrame(_ header: Data) {
        dispatchPrecondition(condition: .onQueue(queue))
        let byte0 = header[0]
        let byte1 = header[1]

        let isFinal = (byte0 & 0x80) != 0
        let opcode = byte0 & 0x0F
        let isMasked = (byte1 & 0x80) != 0
        let payloadLength = UInt64(byte1 & 0x7F)

        // Close frame: echo close, then cancel from the send completion (#5677).
        if opcode == 0x08 {
            sendCloseFrame()
            return
        }

        // Ping (§5.5.2): a client→server frame is always masked (§5.3), so the mask
        // key + payload still sit unread. Route through the masked `readPayload` so
        // those bytes are consumed before the next header (#5669). Control-frame
        // payload ≤ 125 and no extended-length forms (§5.5).
        if opcode == 0x09 {
            guard WebSocketFraming.isValidControlFramePayloadLength(payloadLength) else {
                print("[WebSocketConnection] Ping payload too large (\(payloadLength) bytes), closing connection")
                closeConnection()
                return
            }
            readPayload(length: payloadLength, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
            return
        }

        if payloadLength == 126 {
            readExtendedLength(2, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        } else if payloadLength == 127 {
            readExtendedLength(8, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        } else {
            readPayload(length: payloadLength, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        }
    }

    private func readExtendedLength(_ bytes: Int, isMasked: Bool, opcode: UInt8, isFinal: Bool) {
        dispatchPrecondition(condition: .onQueue(queue))
        receiveFrameBytes(bytes) { [weak self] data in
            guard let self = self else { return }
            var length: UInt64 = 0
            for byte in data {
                length = length << 8 | UInt64(byte)
            }
            self.readPayload(length: length, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        }
    }

    private func readPayload(length: UInt64, isMasked: Bool, opcode: UInt8, isFinal: Bool) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let totalLength = WebSocketFraming.frameReadLength(payloadLength: length, isMasked: isMasked) else {
            print("[WebSocketConnection] Frame payload too large (\(length) bytes), closing connection")
            closeConnection()
            return
        }

        // Reject a malformed/over-budget data/continuation frame from its header,
        // before receiving/unmasking (§5.4, #5674). `accumulate` re-checks post-read.
        if WebSocketFraming.isDataOrContinuation(opcode),
           case let .reject(reason) = WebSocketFraming.preReadDataFrameDecision(
               opcode: opcode,
               declaredPayloadLength: length,
               inProgressOpcode: fragmentedOpcode,
               alreadyBuffered: fragmentBuffer.count
           ) {
            print("[WebSocketConnection] Fragmentation protocol error (pre-read): \(reason), closing connection")
            fragmentedOpcode = nil
            fragmentBuffer = Data()
            closeConnection()
            return
        }

        // A zero-length data/continuation frame still matters for FIN (empty final
        // continuation completes a message; empty non-final data opens one).
        guard totalLength > 0 else {
            if WebSocketFraming.isDataOrContinuation(opcode) {
                handleDataFrame(opcode: opcode, isFinal: isFinal, payload: Data())
            } else {
                receiveWebSocketFrame()
            }
            return
        }

        receiveFrameBytes(totalLength) { [weak self] data in
            guard let self = self else { return }
            let payload: Data = isMasked ? WebSocketFraming.unmaskFrame(data) : data

            if WebSocketFraming.isDataOrContinuation(opcode) {
                self.handleDataFrame(opcode: opcode, isFinal: isFinal, payload: payload)
                return
            }

            // Control frames (ping/pong etc.) never touch the reassembly buffer (§5.4).
            switch WebSocketFraming.frameAction(opcode: opcode, unmaskedPayload: payload) {
            case .deliver:
                break // Unreachable: data opcodes handled above.
            case let .pong(applicationData):
                let pongFrame = WebSocketFraming.createWebSocketFrame(data: applicationData, opcode: 0x0A)
                self.channel.send(pongFrame) { _ in }
            case .ignore:
                break
            }
            self.receiveWebSocketFrame()
        }
    }

    private func handleDataFrame(opcode: UInt8, isFinal: Bool, payload: Data) {
        dispatchPrecondition(condition: .onQueue(queue))
        switch WebSocketFraming.accumulate(
            into: &fragmentBuffer,
            opcode: opcode,
            isFinal: isFinal,
            payload: payload,
            inProgressOpcode: &fragmentedOpcode
        ) {
        case let .deliver(message):
            onMessage(message)
            receiveWebSocketFrame()
        case .buffered:
            receiveWebSocketFrame()
        case let .protocolError(reason):
            print("[WebSocketConnection] Fragmentation protocol error: \(reason), closing connection")
            fragmentedOpcode = nil
            fragmentBuffer = Data()
            closeConnection()
        }
    }

    private func sendCloseFrame() {
        dispatchPrecondition(condition: .onQueue(queue))
        let frame = WebSocketFraming.createWebSocketFrame(data: Data(), opcode: 0x08)
        channel.send(frame) { [weak self] _ in
            self?.channel.cancel()
        }
    }
}
