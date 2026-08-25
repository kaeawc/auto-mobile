import Foundation
import CryptoKit
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

/// A sink for one outbound framed message. `WebSocketConnection` is the
/// production implementation; `WebSocketServerTests` injects a capturing fake so
/// it can drive the real `handleMessage` — including its decode-failure catch —
/// end-to-end without a live `NWConnection` (issue #2859 part 4).
protocol WebSocketResponding: AnyObject {
    func send(_ data: Data)
}

/// Thread-safe registry of active connections keyed by connection id.
///
/// Connect/disconnect run on the server `DispatchQueue`, but broadcasts iterate
/// the connections on the **main** thread (hierarchy debouncer + `CADisplayLink`
/// FPS callbacks). A plain `Dictionary` mutated on one thread while iterated on
/// another is undefined behavior, so every access is serialized by an internal
/// lock and iteration is done over a copied snapshot taken under that lock
/// (issue #3611).
final class ConnectionRegistry<Value> {
    private let lock = NSLock()
    private var storage: [Int: Value] = [:]

    func set(_ value: Value, forId id: Int) {
        lock.lock()
        defer { lock.unlock() }
        storage[id] = value
    }

    func removeValue(forId id: Int) {
        lock.lock()
        defer { lock.unlock() }
        storage[id] = nil
    }

    func value(forId id: Int) -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return storage[id]
    }

    /// Snapshot copy of all current values, safe to iterate outside the lock.
    func values() -> [Value] {
        lock.lock()
        defer { lock.unlock() }
        return Array(storage.values)
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return storage.count
    }

    var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage.isEmpty
    }

    /// Atomically clears the registry, returning the values that were removed.
    func removeAll() -> [Value] {
        lock.lock()
        defer { lock.unlock() }
        let all = Array(storage.values)
        storage.removeAll()
        return all
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

    /// Reusable JSON coders. `JSONEncoder`/`JSONDecoder` are safe to share once
    /// configured (we never mutate them after construction), so a single
    /// pre-configured instance per role avoids allocating and reconfiguring one on
    /// every encoded/decoded message on the hot wire path (issue #5477).
    static let sortedKeysEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return encoder
    }()

    /// Plain encoder for payloads that do not require deterministic key ordering
    /// (e.g. the one-shot connected event).
    static let sharedEncoder = JSONEncoder()

    /// Reusable decoder for inbound request framing.
    static let sharedDecoder = JSONDecoder()

    private var listener: NWListener?
    private let connections = ConnectionRegistry<WebSocketConnection>()
    private var nextConnectionId = 1

    /// Ids of connections that have completed the WebSocket upgrade handshake,
    /// i.e. real subscribed clients — as distinct from transient HTTP connections
    /// (`GET /health`, `POST /sdk-events`) that briefly appear in `connections`.
    /// Guarded by `presenceLock`. Used to gate the always-on device samplers so
    /// they run only while a client is actually connected (issue #5477).
    private var upgradedClientIds = Set<Int>()
    private let presenceLock = NSLock()

    /// Invoked when the connected-client count transitions between zero and
    /// non-zero: `true` when the first client connects, `false` when the last one
    /// disconnects. A transient HTTP request never toggles this. Callbacks fire off
    /// the caller's queue; consumers should hop to their own queue if needed.
    public var onClientPresenceChanged: ((Bool) -> Void)?

    /// Whether at least one WebSocket client is currently connected (upgraded).
    public var hasConnectedClients: Bool {
        presenceLock.lock()
        defer { presenceLock.unlock() }
        return !upgradedClientIds.isEmpty
    }

    private let port: UInt16
    private let commandHandler: CommandHandler
    private let perfProvider: PerfProvider
    private let sdkHierarchyCache: SdkHierarchyCache?
    private let frameContext: FrameContext
    private let broadcastSink: ((Data) -> Void)?
    private let queue = DispatchQueue(label: "com.ctrlproxy.server")
    /// Command execution runs here, off the accept/`queue`, so a long XCUITest
    /// walk or screenshot cannot starve `GET /health`, `POST /sdk-events`, or new
    /// connection accepts — all of which are serviced on `queue`. A single
    /// serial queue preserves per-connection command ordering (issue #5374).
    private let commandQueue = DispatchQueue(label: "com.ctrlproxy.command")
    var onSdkHierarchyUpdated: (() -> Void)?

    public var isRunning: Bool {
        listener != nil
    }

    public init(
        port: UInt16 = 8765,
        commandHandler: CommandHandler,
        perfProvider: PerfProvider = PerfProvider.instance,
        sdkHierarchyCache: SdkHierarchyCache? = nil,
        frameContext: FrameContext = FrameContext()
    ) {
        self.port = port
        self.commandHandler = commandHandler
        self.perfProvider = perfProvider
        self.sdkHierarchyCache = sdkHierarchyCache
        self.frameContext = frameContext
        broadcastSink = nil
    }

    init(
        port: UInt16,
        commandHandler: CommandHandler,
        perfProvider: PerfProvider,
        sdkHierarchyCache: SdkHierarchyCache?,
        frameContext: FrameContext,
        broadcastSink: ((Data) -> Void)?
    ) {
        self.port = port
        self.commandHandler = commandHandler
        self.perfProvider = perfProvider
        self.sdkHierarchyCache = sdkHierarchyCache
        self.frameContext = frameContext
        self.broadcastSink = broadcastSink
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
        connections.removeAll().forEach { $0.close() }
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
            boundPort: port,
            sdkHierarchyCache: sdkHierarchyCache,
            onSdkHierarchyUpdated: { [weak self] in
                self?.onSdkHierarchyUpdated?()
            },
            onUpgrade: { [weak self] in
                self?.clientDidUpgrade(connectionId)
            }
        ) { [weak self] message in
            self?.handleMessage(message, connectionId: connectionId)
        } onClose: { [weak self] in
            self?.connections.removeValue(forId: connectionId)
            self?.clientDidDisconnect(connectionId)
        }

        connections.set(connection, forId: connectionId)
        connection.start()
    }

    /// Records that a connection completed the WebSocket upgrade, firing the
    /// presence hook only on the zero → non-zero transition. Internal (not
    /// `private`) so `WebSocketServerTests` can drive the presence bookkeeping
    /// without a live socket (issue #5477).
    func clientDidUpgrade(_ id: Int) {
        presenceLock.lock()
        let wasEmpty = upgradedClientIds.isEmpty
        upgradedClientIds.insert(id)
        presenceLock.unlock()

        if wasEmpty {
            onClientPresenceChanged?(true)
        }
    }

    /// Records that a connection closed, firing the presence hook only on the
    /// non-zero → zero transition. A never-upgraded (HTTP-only) connection is a
    /// no-op here, so `/health` probes never toggle presence.
    func clientDidDisconnect(_ id: Int) {
        presenceLock.lock()
        let wasPresent = !upgradedClientIds.isEmpty
        upgradedClientIds.remove(id)
        let nowEmpty = upgradedClientIds.isEmpty
        presenceLock.unlock()

        if wasPresent, nowEmpty {
            onClientPresenceChanged?(false)
        }
    }

    private func handleMessage(_ data: Data, connectionId: Int) {
        guard let connection = connections.value(forId: connectionId) else { return }
        dispatchCommand(data, responder: connection)
    }

    /// Runs one command off the server `queue` on the serial `commandQueue`.
    ///
    /// The accept loop, `GET /health`, and `POST /sdk-events` are all serviced on
    /// `queue`; before this hop, a slow command (an XCUITest element-tree walk, a
    /// screenshot, or a semaphore-blocked SDK HTTP call) ran inline on `queue` and
    /// starved them — a live-but-unresponsive runner whose `/health` probes time
    /// out mid-run (issue #5374). Offloading keeps `queue` free while commands run
    /// serially here, preserving per-connection ordering. `responder` is captured
    /// strongly so it outlives the hop; `NWConnection.send` is thread-safe.
    ///
    /// Internal, not private, so `WebSocketServerTests` can drive the offload with a
    /// fake responder and assert the caller is not blocked while a command runs.
    func dispatchCommand(_ data: Data, responder: WebSocketResponding) {
        commandQueue.async { [weak self] in
            self?.handleMessage(data, responder: responder)
        }
    }

    /// Decode → dispatch → encode → send, with the decode-failure `catch` #2854
    /// moved here from `CommandHandler.handle`: it recovers the correlation id from
    /// the raw JSON (`extractRequestId`) and emits a structured error envelope
    /// (`sendErrorResponse`). Internal and connection-abstracted (via
    /// `WebSocketResponding`) so `WebSocketServerTests` can drive this whole path —
    /// including the catch's `extractRequestId`/`sendErrorResponse` wiring — with a
    /// fake responder, no live `NWConnection` (issue #2859 part 4).
    func handleMessage(_ data: Data, responder: WebSocketResponding) {
        do {
            let request = try Self.sharedDecoder.decode(WebSocketRequest.self, from: data)
            print("[WebSocketServer] Received request type=\(request.typeString) requestId=\(request.requestId ?? "nil")")

            // Track the entire request handling with PerfProvider
            perfProvider.serial("handleRequest:\(request.typeString)")
            let startTime = Date()

            let response = commandHandler.handle(request)
            let totalTimeMs = Int64(Date().timeIntervalSince(startTime) * 1000)

            perfProvider.end()

            // Flush perf timing data and encode response
            let perfTiming = flushPerfTiming()
            let responseData = try encodeResponse(response, totalTimeMs: totalTimeMs, perfTiming: perfTiming)
            responder.send(responseData)

        } catch {
            print("[WebSocketServer] Error handling message: \(error)")
            perfProvider.clear()
            let requestId = Self.extractRequestId(from: data)
            Self.sendErrorResponse(responder: responder, requestId: requestId, error: error)
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
        let encoder = Self.sortedKeysEncoder

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
                    error: hierarchyResponse.error,
                    frameContext: hierarchyResponse.frameContext
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
        if let broadcastSink {
            broadcastSink(data)
            return
        }
        for connection in connections.values() {
            connection.send(data)
        }
    }

    /// Broadcast a hierarchy update to all connected clients (push notification)
    public func broadcastHierarchyUpdate(_ hierarchy: ViewHierarchy) {
        let context = frameContext.recordTransition(to: hierarchy)
        let response = HierarchyUpdateResponse(
            requestId: nil, // No requestId for push updates
            data: hierarchy,
            perfTiming: nil,
            frameContext: context
        )

        do {
            let data = try Self.sortedKeysEncoder.encode(response)
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
            let data = try Self.sortedKeysEncoder.encode(response)
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
    static func sendErrorResponse(responder: WebSocketResponding, requestId: String?, error: Error) {
        let data = buildErrorResponseData(requestId: requestId, error: error)
        responder.send(data)
    }

    /// Builds error response data, falling back to hand-crafted JSON if encoding fails.
    static func buildErrorResponseData(requestId: String?, error: Error) -> Data {
        let errorResponse = WebSocketResponse.error(
            type: "error",
            requestId: requestId,
            error: wireErrorMessage(for: error)
        )

        do {
            return try sortedKeysEncoder.encode(errorResponse)
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

    /// Maps a caught error into the message surfaced on the wire.
    ///
    /// Two `DecodingError` contracts pass through `localizedDescription` **unchanged**
    /// — deliberately, and load-bearing:
    /// - `CommandError.unknownCommand`'s "Unknown command type: <type>" (a
    ///   `LocalizedError`, matched by the TS `rewriteUnknownCommandError`).
    /// - `DecodingError.keyNotFound`'s required-field rejection messages, which
    ///   `TypedRequestDecodeTests` pins byte-for-byte (see #2965 AC2).
    ///
    /// The rewritten cases are the `DecodingError`s whose `localizedDescription`
    /// collapses to an opaque default even though a more actionable cause is
    /// recoverable:
    /// - `dataCorrupted` — "The data couldn't be read because it isn't in the correct
    ///   format." Apple's `JSONDecoder` reports this at top-level pre-parse with an
    ///   *empty* `codingPath` (most notably an out-of-range numeric literal like
    ///   `1e309`), so a per-field message is infeasible there, but the real cause
    ///   survives in the underlying Cocoa error's `NSDebugDescription`. See #2965.
    /// - `typeMismatch` / `valueNotFound` — same opaque string, but these carry a
    ///   *non-empty* `codingPath`, so the offending field can be named. A string
    ///   where a number is expected, or an explicit `null` for a required field,
    ///   becomes "…wrong type for field 'x' (…)" / "…missing value for field 'x' (…)"
    ///   instead of the decoder default. See #2986. (The value is already rejected;
    ///   this is diagnostic legibility only.)
    static func wireErrorMessage(for error: Error) -> String {
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

    /// A human-readable name for the offending field, derived from the deepest
    /// `codingPath` key, or `nil` when the path is empty (nothing to attribute).
    ///
    /// A named leaf key (the common case — a wrong-typed *field* like `x`) is used
    /// verbatim. When the leaf is an **array index** (a wrong-typed array *element*,
    /// e.g. `rules[0]`), the synthetic "Index 0" key `stringValue` would be a poor
    /// label, so it is attributed to the nearest named ancestor with the index
    /// appended (`rules[0]`), or just `[0]` if there is no named ancestor.
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

    /// Actionable message for a `DecodingError.dataCorrupted`. The overflow / malformed
    /// -JSON cases (empty `codingPath`, cause in the underlying Cocoa error) are the
    /// common ones; the final fallback also attributes a field when a *nested*
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
        // No underlying detail available — the decoder's own context description is
        // still more specific than the opaque `localizedDescription`; attribute the
        // field when a nested dataCorrupted carries one.
        if let field = fieldName(context) {
            return "Malformed request: field '\(field)' — \(context.debugDescription)"
        }
        return "Malformed request: \(context.debugDescription)"
    }

    /// Whether a Cocoa 3840 `NSDebugDescription` denotes an out-of-range / non-
    /// representable numeric literal (rather than a JSON syntax error). The exact
    /// phrasing differs by the `JSONDecoder` backend the runner is running on:
    /// - swift-foundation (iOS 18+, macOS 15+): "Number 1e309 is not representable in Swift."
    /// - classic Foundation (iOS 15–17, `JSONSerialization`-backed): "Number wound up as NaN around line 1, column 5."
    /// `Package.swift` deploys to `.iOS(.v15)`, so both must be recognized — matching
    /// only "not representable" would silently miss the overflow case on iOS 15–17.
    private static func isNumberOutOfRangeDetail(_ detail: String) -> Bool {
        detail.localizedCaseInsensitiveContains("not representable")
            || detail.localizedCaseInsensitiveContains("wound up as nan")
    }

    /// Best-effort extraction of requestId from raw JSON data for error correlation.
    /// Internal (not `private`) so `WebSocketServerTests` can pin the decode-failure
    /// catch path via `@testable` (issue #2859 part 4).
    static func extractRequestId(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["requestId"] as? String
    }
}

// MARK: - WebSocket Connection

/// Handles a single WebSocket connection with handshake and framing
class WebSocketConnection: WebSocketResponding {
    let id: Int
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let onMessage: (Data) -> Void
    private let onClose: () -> Void
    private let onUpgrade: (() -> Void)?
    private let sdkHierarchyCache: (any SdkHierarchyCaching)?
    private let onSdkHierarchyUpdated: (() -> Void)?
    /// The port the server is actually bound to; echoed in /health so the daemon
    /// can detect a runner/client port mismatch (issue #2735).
    private let boundPort: UInt16
    private var isWebSocketUpgraded = false
    private var pendingHTTPRequest = Data()
    private static let maximumHTTPRequestLength = 1_000_000

    /// In-progress fragmented-message reassembly state (RFC 6455 §5.4). Both are
    /// mutated **only** from `connection.receive` completions, which all run on the
    /// server `queue` (`connection.start(queue:)` binds them there) and are
    /// therefore serialized — so no lock is needed. `fragmentedOpcode` is the data
    /// opcode (0x1/0x2) of the message being assembled, or nil when none is open;
    /// `fragmentBuffer` accumulates the ordered payload bytes (issue #5674).
    private var fragmentedOpcode: UInt8?
    private var fragmentBuffer = Data()

    init(
        id: Int,
        connection: NWConnection,
        queue: DispatchQueue,
        boundPort: UInt16,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        onSdkHierarchyUpdated: (() -> Void)? = nil,
        onUpgrade: (() -> Void)? = nil,
        onMessage: @escaping (Data) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.id = id
        self.connection = connection
        self.queue = queue
        self.boundPort = boundPort
        self.sdkHierarchyCache = sdkHierarchyCache
        self.onSdkHierarchyUpdated = onSdkHierarchyUpdated
        self.onUpgrade = onUpgrade
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
        let frame = Self.createWebSocketFrame(data: data, opcode: 0x01) // Text frame
        connection.send(content: frame, completion: .contentProcessed { error in
            if let error = error {
                print("[WebSocketConnection] Send error: \(error)")
            }
        })
    }

    // MARK: - WebSocket Handshake

    private func receiveHTTPUpgrade() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.maximumHTTPRequestLength) { [weak self] data, _, isComplete, error in
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

            guard let data = data else {
                self.receiveHTTPUpgrade()
                return
            }

            self.pendingHTTPRequest.append(data)
            guard self.pendingHTTPRequest.count <= Self.maximumHTTPRequestLength else {
                print("[WebSocketConnection] HTTP request exceeds maximum length")
                self.connection.cancel()
                return
            }

            guard let requestLength = Self.completeHTTPRequestLength(in: self.pendingHTTPRequest) else {
                self.receiveHTTPUpgrade()
                return
            }

            let requestData = Data(self.pendingHTTPRequest.prefix(requestLength))
            self.pendingHTTPRequest.removeFirst(requestLength)
            guard let request = String(data: requestData, encoding: .utf8) else {
                self.connection.cancel()
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

    /// Returns the byte count of one complete HTTP request, including its body,
    /// or `nil` until another network read supplies the missing bytes.
    static func completeHTTPRequestLength(in data: Data) -> Int? {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: separator) else {
            return nil
        }

        let headerLength = headerRange.upperBound
        guard let header = String(data: data.prefix(headerLength), encoding: .utf8) else {
            return nil
        }

        let contentLength = header
            .components(separatedBy: "\r\n")
            .compactMap { line -> Int? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard let delimiter = trimmed.firstIndex(of: ":") else {
                    return nil
                }
                let name = String(trimmed[..<delimiter])
                guard name.caseInsensitiveCompare("Content-Length") == .orderedSame
                else {
                    return nil
                }
                let value = String(trimmed[trimmed.index(after: delimiter)...].trimmingCharacters(in: .whitespaces))
                return Int(value)
            }
            .first ?? 0
        guard contentLength >= 0,
              headerLength <= Self.maximumHTTPRequestLength - contentLength
        else {
            return nil
        }

        let requestLength = headerLength + contentLength
        return data.count >= requestLength ? requestLength : nil
    }

    private func handleHealthCheck() {
        var payload: [String: Any] = ["status": "ok", "port": Int(boundPort)]
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
                    SdkHierarchyExtractor.extractIfPresent(
                        from: bodyData,
                        into: cache,
                        onHierarchyUpdated: onSdkHierarchyUpdated
                    )
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
        // A String always encodes to UTF-8, so .data(using: .utf8) is never nil.
    let acceptKey = (key + magic).data(using: .utf8)!.sha1().base64EncodedString()  // swiftlint:disable:this force_unwrapping

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
            self?.onUpgrade?()
            self?.sendConnectedEvent()
            self?.receiveWebSocketFrame()
        })
    }

    private func sendConnectedEvent() {
        let event = ConnectedEvent(id: id)
        do {
            let data = try WebSocketServer.sharedEncoder.encode(event)
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

        let isFinal = (byte0 & 0x80) != 0
        let opcode = byte0 & 0x0F
        let isMasked = (byte1 & 0x80) != 0
        let payloadLength = UInt64(byte1 & 0x7F)

        // Handle close frame
        if opcode == 0x08 {
            sendCloseFrame()
            onClose()
            return
        }

        // Handle ping (RFC 6455 §5.5.2). A client→server frame is always masked
        // (§5.3), so the masking key and any ping payload still sit unread in the
        // stream after the 2-byte header. Route the ping through the same masked
        // `readPayload` path as data frames so those bytes are consumed before the
        // next frame header is read — otherwise the mask bytes are mis-read as a
        // new header and the wire desyncs (issue #5669). A control-frame payload is
        // at most 125 bytes and MUST NOT use the 126/127 extended-length forms
        // (§5.5); a ping violating that is malformed → close rather than mis-parse.
        if opcode == 0x09 {
            guard Self.isValidControlFramePayloadLength(payloadLength) else {
                print("[WebSocketConnection] Ping payload too large (\(payloadLength) bytes), closing connection")
                onClose()
                return
            }
            readPayload(length: payloadLength, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
            return
        }

        // Read extended length if needed
        if payloadLength == 126 {
            readExtendedLength(2, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        } else if payloadLength == 127 {
            readExtendedLength(8, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        } else {
            readPayload(length: payloadLength, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        }
    }

    private func readExtendedLength(_ bytes: Int, isMasked: Bool, opcode: UInt8, isFinal: Bool) {
        connection.receive(minimumIncompleteLength: bytes, maximumLength: bytes) { [weak self] data, _, _, _ in
            guard let self = self, let data = data else {
                self?.onClose()
                return
            }

            var length: UInt64 = 0
            for byte in data {
                length = length << 8 | UInt64(byte)
            }

            self.readPayload(length: length, isMasked: isMasked, opcode: opcode, isFinal: isFinal)
        }
    }

    /// Maximum accepted WebSocket frame payload (64 MiB). Frames declaring a
    /// larger payload are rejected rather than trapping the `Int(length)`
    /// conversion (which crashes for `length > Int.max`) or attempting an
    /// enormous allocation (issue #3626).
    static let maxFramePayloadLength: UInt64 = 64 * 1024 * 1024

    /// Validate a frame payload length and compute the total bytes to read
    /// (payload + mask). Returns `nil` when the payload exceeds `maxPayload`, so
    /// the caller closes the connection instead of trapping/over-allocating.
    static func frameReadLength(
        payloadLength: UInt64,
        isMasked: Bool,
        maxPayload: UInt64 = maxFramePayloadLength
    ) -> Int? {
        guard payloadLength <= maxPayload else { return nil }
        return Int(payloadLength) + (isMasked ? 4 : 0)
    }

    /// Unmask a masked WebSocket frame whose first 4 bytes are the masking key and
    /// whose remaining bytes are the masked payload (RFC 6455 §5.3).
    ///
    /// The previous implementation appended one byte at a time to a growing `Data`,
    /// reallocating repeatedly for large payloads. This pre-sizes the output and
    /// XORs through raw buffer pointers, so a payload of N bytes is a single
    /// allocation plus a tight loop (issue #5477). Internal (not `private`) so
    /// `WebSocketServerTests` can pin it against a reference XOR.
    static func unmaskFrame(_ frame: Data) -> Data {
        guard frame.count > 4 else { return Data() }
        let payloadCount = frame.count - 4
        var unmasked = Data(count: payloadCount)
        frame.withUnsafeBytes { (rawIn: UnsafeRawBufferPointer) in
            unmasked.withUnsafeMutableBytes { (rawOut: UnsafeMutableRawBufferPointer) in
                let src = rawIn.bindMemory(to: UInt8.self)
                let dst = rawOut.bindMemory(to: UInt8.self)
                for i in 0 ..< payloadCount {
                    dst[i] = src[4 + i] ^ src[i & 3]
                }
            }
        }
        return unmasked
    }

    /// RFC 6455 §5.5: a control-frame payload is at most 125 bytes and MUST NOT
    /// use the 126/127 extended-length forms. Ping length is validated with this
    /// bound (a stricter cousin of `maxFramePayloadLength` for control frames)
    /// before the payload is read, so a malformed/oversized ping closes the
    /// connection instead of being mis-parsed (issue #5669).
    static let maxControlFramePayloadLength: UInt64 = 125

    static func isValidControlFramePayloadLength(_ payloadLength: UInt64) -> Bool {
        payloadLength <= maxControlFramePayloadLength
    }

    /// What to do with a frame whose payload has been fully read and unmasked.
    /// Keeping the decision pure (opcode + unmasked bytes in, action out) lets the
    /// ping → pong-echo and data-delivery wiring be unit-tested without a socket
    /// (issue #5669).
    enum FrameAction: Equatable {
        /// Text/binary frame → deliver as an application message.
        case deliver(Data)
        /// Ping frame → reply with a pong echoing the application data (§5.5.3).
        case pong(Data)
        /// Pong and other non-actionable opcodes → consumed, nothing to emit.
        case ignore
    }

    static func frameAction(opcode: UInt8, unmaskedPayload: Data) -> FrameAction {
        switch opcode {
        case 0x01, 0x02: return .deliver(unmaskedPayload)
        case 0x09: return .pong(unmaskedPayload)
        default: return .ignore
        }
    }

    /// The reassembly decision for a data (0x1/0x2) or continuation (0x0) frame —
    /// control frames are handled before this and never reach it. Pure (state in,
    /// action out) so the fragmentation semantics can be unit-tested without a
    /// socket, mirroring `frameAction` (issue #5674).
    enum FragmentDecision: Equatable {
        /// The message is complete → deliver these fully-reassembled bytes.
        case deliver(Data)
        /// A fragment was stored; more frames are expected. Carries the opcode now
        /// in progress and the accumulated buffer so the caller can update the
        /// per-connection reassembly state.
        case buffered(opcode: UInt8, buffer: Data)
        /// A malformed fragmentation sequence or an exceeded total-size bound →
        /// the caller closes the connection rather than mis-delivering (§5.4).
        case protocolError(String)
    }

    /// Applies one data/continuation frame to the in-progress reassembly state and
    /// decides the next action (RFC 6455 §5.4):
    ///
    /// - A text/binary frame (0x1/0x2) with FIN=1 and nothing in progress is a
    ///   complete single-frame message → `.deliver` verbatim (no regression).
    /// - A text/binary frame with FIN=0 starts a fragmented message → `.buffered`.
    /// - A continuation frame (0x0) extends the in-progress message; on FIN=1 it
    ///   completes → `.deliver` the ordered concatenation, otherwise `.buffered`.
    /// - A continuation with nothing in progress, or a new data frame while a
    ///   message is still open, is malformed → `.protocolError`.
    /// - The **total** reassembled size is bounded by `maxTotal` (the per-frame
    ///   `maxFramePayloadLength` applied cumulatively); exceeding it is a
    ///   `.protocolError` so the buffer cannot grow unboundedly.
    static func reassemble(
        opcode: UInt8,
        isFinal: Bool,
        payload: Data,
        inProgressOpcode: UInt8?,
        accumulated: Data,
        maxTotal: UInt64 = maxFramePayloadLength
    ) -> FragmentDecision {
        switch opcode {
        case 0x01, 0x02:
            // A new data frame is illegal while a fragmented message is still open.
            if inProgressOpcode != nil {
                return .protocolError("new data frame (opcode 0x\(String(opcode, radix: 16))) while a fragmented message is open")
            }
            guard UInt64(payload.count) <= maxTotal else {
                return .protocolError("frame payload exceeds \(maxTotal) bytes")
            }
            return isFinal ? .deliver(payload) : .buffered(opcode: opcode, buffer: payload)

        case 0x00:
            // A continuation frame requires an in-progress message.
            guard let openOpcode = inProgressOpcode else {
                return .protocolError("continuation frame with no message in progress")
            }
            guard UInt64(accumulated.count) + UInt64(payload.count) <= maxTotal else {
                return .protocolError("reassembled message exceeds \(maxTotal) bytes")
            }
            var combined = accumulated
            combined.append(payload)
            return isFinal ? .deliver(combined) : .buffered(opcode: openOpcode, buffer: combined)

        default:
            // Reserved / unexpected data opcode (control frames never reach here).
            return .protocolError("unsupported opcode 0x\(String(opcode, radix: 16))")
        }
    }

    private func readPayload(length: UInt64, isMasked: Bool, opcode: UInt8, isFinal: Bool) {
        guard let totalLength = Self.frameReadLength(payloadLength: length, isMasked: isMasked) else {
            print("[WebSocketConnection] Frame payload too large (\(length) bytes), closing connection")
            onClose()
            return
        }

        // A zero-length frame carries no payload/mask bytes to read, but for a
        // data/continuation frame the FIN bit still matters: an empty final
        // continuation completes a fragmented message, and an empty non-final data
        // frame opens one. Route it through reassembly with an empty payload rather
        // than skipping straight to the next frame.
        guard totalLength > 0 else {
            if Self.isDataOrContinuation(opcode) {
                handleDataFrame(opcode: opcode, isFinal: isFinal, payload: Data())
            } else {
                receiveWebSocketFrame()
            }
            return
        }

        connection
            .receive(minimumIncompleteLength: totalLength, maximumLength: totalLength) { [weak self] data, _, _, _ in
                guard let self = self, let data = data else {
                    self?.onClose()
                    return
                }

                let payload: Data = isMasked ? Self.unmaskFrame(data) : data

                if Self.isDataOrContinuation(opcode) {
                    self.handleDataFrame(opcode: opcode, isFinal: isFinal, payload: payload)
                    return
                }

                // Control frames (ping/pong and any non-data opcode) are handled
                // independently and never touch the reassembly buffer (§5.4).
                switch Self.frameAction(opcode: opcode, unmaskedPayload: payload) {
                case .deliver:
                    // Unreachable: data opcodes are handled above via reassembly.
                    break
                case let .pong(applicationData):
                    // Echo the ping application data back in the pong (§5.5.3).
                    let pongFrame = Self.createWebSocketFrame(data: applicationData, opcode: 0x0A)
                    self.connection.send(content: pongFrame, completion: .contentProcessed { _ in })
                case .ignore:
                    break
                }

                self.receiveWebSocketFrame()
            }
    }

    /// Whether `opcode` denotes a data (text/binary) or continuation frame — the
    /// frames that participate in fragmentation reassembly (§5.4).
    static func isDataOrContinuation(_ opcode: UInt8) -> Bool {
        opcode == 0x00 || opcode == 0x01 || opcode == 0x02
    }

    /// Feeds one data/continuation frame through the pure `reassemble` state
    /// machine, updating the per-connection reassembly state and delivering the
    /// completed message, buffering, or closing on a malformed sequence. Runs on
    /// the server `queue` (see `fragmentedOpcode`), so the mutations are serialized.
    private func handleDataFrame(opcode: UInt8, isFinal: Bool, payload: Data) {
        switch WebSocketConnection.reassemble(
            opcode: opcode,
            isFinal: isFinal,
            payload: payload,
            inProgressOpcode: fragmentedOpcode,
            accumulated: fragmentBuffer
        ) {
        case let .deliver(message):
            fragmentedOpcode = nil
            fragmentBuffer = Data()
            onMessage(message)
            receiveWebSocketFrame()
        case let .buffered(openOpcode, buffer):
            fragmentedOpcode = openOpcode
            fragmentBuffer = buffer
            receiveWebSocketFrame()
        case let .protocolError(reason):
            print("[WebSocketConnection] Fragmentation protocol error: \(reason), closing connection")
            fragmentedOpcode = nil
            fragmentBuffer = Data()
            onClose()
        }
    }

    /// Build an unmasked server→client frame (server frames are never masked,
    /// RFC 6455 §5.1). `static` and internal so the pong-echo wire format can be
    /// pinned by `WebSocketServerTests` (issue #5669).
    static func createWebSocketFrame(data: Data, opcode: UInt8) -> Data {
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
        let frame = Self.createWebSocketFrame(data: Data(), opcode: 0x08)
        connection.send(content: frame, completion: .contentProcessed { _ in })
    }
}

// MARK: - SHA1 Extension

extension Data {
    func sha1() -> Data {
        Data(Insecure.SHA1.hash(data: self))
    }
}

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
