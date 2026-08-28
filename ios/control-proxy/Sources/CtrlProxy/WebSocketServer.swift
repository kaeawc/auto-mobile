import CryptoKit
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
        while buffer.count > maxEvents {
            buffer.removeFirst()
        }
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
    /// Only connections that completed the RFC 6455 upgrade. HTTP probes share
    /// the accept path but must never receive framed WebSocket broadcasts.
    private let upgradedConnections = ConnectionRegistry<WebSocketResponding>()
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
        _ = upgradedConnections.removeAll()
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
        if let connection = connections.value(forId: id) {
            upgradedConnections.set(connection, forId: id)
        }
        presenceLock.lock()
        let wasEmpty = upgradedClientIds.isEmpty
        upgradedClientIds.insert(id)
        presenceLock.unlock()

        if wasEmpty {
            onClientPresenceChanged?(true)
        }
    }

    /// Test seam for pinning the broadcast routing invariant without opening a
    /// real socket. Production upgrades are registered by `clientDidUpgrade`.
    func registerUpgradedResponderForTesting(_ responder: WebSocketResponding, id: Int) {
        upgradedConnections.set(responder, forId: id)
    }

    /// Records that a connection closed, firing the presence hook only on the
    /// non-zero → zero transition. A never-upgraded (HTTP-only) connection is a
    /// no-op here, so `/health` probes never toggle presence.
    func clientDidDisconnect(_ id: Int) {
        upgradedConnections.removeValue(forId: id)
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
            print(
                "[WebSocketServer] Received request type=\(request.typeString) requestId=\(request.requestId ?? "nil")"
            )

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
        for connection in upgradedConnections.values() {
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
            {"type":"error","success":false,"requestId":\(requestIdJSON),"error":"[encoding fallback] \(
                sanitizedError
            )","timestamp":\(Int64(
                Date()
                    .timeIntervalSince1970 * 1000
            ))}
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

// MARK: - Byte transport seam

/// The lifecycle transitions `WebSocketConnection` reacts to, distilled from the
/// `NWConnection.State` cases it actually acts on (`.ready` starts the handshake
/// read; `.failed`/`.cancelled` fire the one-shot close). Modeling only these
/// keeps the test seam small while preserving the exact behavior.
enum ByteChannelState {
    case ready
    case failed
    case cancelled
}

/// The minimal byte-transport surface `WebSocketConnection` needs from its
/// socket: start, a state callback, length-bounded receive, framed send, and
/// cancel. `NWByteChannel` is the production implementation (a 1:1 forward to
/// `NWConnection`); `WebSocketServerTests` injects a scripted fake so framing
/// tests can drive the handshake→frame handoff, the EOF-coalescing path, ping
/// consume, fragmentation reassembly, and close-path teardown with exact byte
/// chunks — without a live `NWConnection` or any dependence on TCP segmentation
/// (issue #5680). The `receive` signature mirrors `NWConnection.receive`'s
/// completion shape (data, isComplete, error), dropping only the unused
/// `ContentContext`.
protocol ByteChannel: AnyObject {
    /// Invoked on each lifecycle transition the connection cares about. Set
    /// before `start` and delivered on the channel's queue in production.
    var onState: ((ByteChannelState) -> Void)? { get set }
    func start(queue: DispatchQueue)
    func receive(
        minimumIncompleteLength: Int,
        maximumLength: Int,
        completion: @escaping (Data?, Bool, Error?) -> Void
    )
    func send(_ data: Data, completion: @escaping (Error?) -> Void)
    func cancel()
}

/// Production `ByteChannel` backed by a real `NWConnection`. Forwards every call
/// unchanged so the wire behavior is identical to talking to `NWConnection`
/// directly; the only reason it exists is to let tests substitute a scripted
/// channel at the same seam (issue #5680).
final class NWByteChannel: ByteChannel {
    private let connection: NWConnection
    var onState: ((ByteChannelState) -> Void)?

    init(_ connection: NWConnection) {
        self.connection = connection
    }

    func start(queue: DispatchQueue) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.onState?(.ready)
            case .failed:
                self?.onState?(.failed)
            case .cancelled:
                self?.onState?(.cancelled)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func receive(
        minimumIncompleteLength: Int,
        maximumLength: Int,
        completion: @escaping (Data?, Bool, Error?) -> Void
    ) {
        connection
            .receive(
                minimumIncompleteLength: minimumIncompleteLength,
                maximumLength: maximumLength
            ) { data, _, isComplete, error in
                completion(data, isComplete, error)
            }
    }

    func send(_ data: Data, completion: @escaping (Error?) -> Void) {
        connection.send(content: data, completion: .contentProcessed { error in
            completion(error)
        })
    }

    func cancel() {
        connection.cancel()
    }
}

// MARK: - WebSocket Connection

/// Handles a single WebSocket connection with handshake and framing
class WebSocketConnection: WebSocketResponding {
    let id: Int
    private let channel: ByteChannel
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
    /// Single per-connection inbound byte buffer drained by **both** the handshake
    /// reader (`receiveHTTPUpgrade`) and the frame reader (`receiveFrameBytes`).
    /// The handshake reader accumulates socket reads here and slices out one
    /// complete HTTP request; any bytes left after that slice — most importantly a
    /// WebSocket frame pipelined in the same TCP segment as the upgrade request —
    /// stay in the buffer and are handed to the frame parser rather than being
    /// stranded and lost (issue #5678). Mutated only from `connection.receive`
    /// completions, which all run on the server `queue`, so no lock is needed
    /// (same invariant as `fragmentedOpcode`/`fragmentBuffer`).
    private var inboundBuffer = Data()
    private static let maximumHTTPRequestLength = 1_000_000

    /// In-progress fragmented-message reassembly state (RFC 6455 §5.4). Both are
    /// mutated **only** from `connection.receive` completions, which all run on the
    /// server `queue` (`connection.start(queue:)` binds them there) and are
    /// therefore serialized — so no lock is needed. `fragmentedOpcode` is the data
    /// opcode (0x1/0x2) of the message being assembled, or nil when none is open;
    /// `fragmentBuffer` accumulates the ordered payload bytes (issue #5674).
    private var fragmentedOpcode: UInt8?
    private var fragmentBuffer = Data()

    /// Whether `onClose` has already fired for this connection. Every error/close
    /// path now cancels the `NWConnection` and lets the `.cancelled` state
    /// transition invoke `onClose`, but Network.framework can deliver both
    /// `.failed` and `.cancelled` for one socket, so this guard keeps the callback
    /// — which removes the connection from the registry and updates presence
    /// bookkeeping — firing exactly once (issue #5677). Touched only from the state
    /// handler and receive/send completions, all of which run on the server
    /// `queue`, so it needs no lock (same invariant as the reassembly state).
    private var didFireClose = false

    /// Designated initializer over the `ByteChannel` seam. Production wraps a real
    /// `NWConnection` (see the `connection:` convenience init); tests inject a
    /// scripted channel to drive framing deterministically (issue #5680).
    init(
        id: Int,
        channel: ByteChannel,
        queue: DispatchQueue,
        boundPort: UInt16,
        sdkHierarchyCache: (any SdkHierarchyCaching)? = nil,
        onSdkHierarchyUpdated: (() -> Void)? = nil,
        onUpgrade: (() -> Void)? = nil,
        onMessage: @escaping (Data) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.id = id
        self.channel = channel
        self.queue = queue
        self.boundPort = boundPort
        self.sdkHierarchyCache = sdkHierarchyCache
        self.onSdkHierarchyUpdated = onSdkHierarchyUpdated
        self.onUpgrade = onUpgrade
        self.onMessage = onMessage
        self.onClose = onClose
    }

    /// Production convenience initializer: wraps a real `NWConnection` in an
    /// `NWByteChannel`. Keeps the call site in `handleNewConnection` (and the
    /// existing socket-free tests that pass an unstarted `NWConnection`) unchanged.
    convenience init(
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
        self.init(
            id: id,
            channel: NWByteChannel(connection),
            queue: queue,
            boundPort: boundPort,
            sdkHierarchyCache: sdkHierarchyCache,
            onSdkHierarchyUpdated: onSdkHierarchyUpdated,
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

    /// Deterministically tears the socket down on an error/close path by
    /// cancelling the `NWConnection`, mirroring how `close()` / `stop()` already
    /// release the socket. The `.cancelled` state transition then invokes `onClose`
    /// exactly once via `fireOnClose()`, so no error/close path is left calling
    /// `onClose` directly and leaking a half-open connection whose file descriptor
    /// lingers until the peer disconnects (issue #5677). `NWConnection.cancel()` is
    /// idempotent, so a path that cancels and then also observes `.failed` /
    /// `.cancelled` stays safe. Runs on the server `queue` (every receive/send
    /// completion does), so it needs no lock.
    private func closeConnection() {
        channel.cancel()
    }

    /// Invokes the `onClose` callback at most once per connection. Called only from
    /// the `.failed` / `.cancelled` state handler now that every error/close path
    /// cancels the connection rather than calling `onClose` inline; the
    /// `didFireClose` guard collapses a `.failed`-then-`.cancelled` pair (or any
    /// repeat) into a single `onClose` (issue #5677 AC2). Internal, not private, so
    /// `WebSocketServerTests` can pin the exactly-once contract without a live
    /// socket. Runs on the server `queue`, so the guard needs no lock.
    func fireOnClose() {
        guard !didFireClose else { return }
        didFireClose = true
        onClose()
    }

    func send(_ data: Data) {
        let frame = Self.createWebSocketFrame(data: data, opcode: 0x01) // Text frame
        channel.send(frame) { error in
            if let error = error {
                print("[WebSocketConnection] Send error: \(error)")
            }
        }
    }

    // MARK: - WebSocket Handshake

    private func receiveHTTPUpgrade() {
        channel
            .receive(
                minimumIncompleteLength: 1,
                maximumLength: Self.maximumHTTPRequestLength
            ) { [weak self] data, isComplete, error in
                guard let self = self else { return }

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

                guard let requestLength = Self.completeHTTPRequestLength(in: self.inboundBuffer) else {
                    self.receiveHTTPUpgrade()
                    return
                }

                let requestData = Data(self.inboundBuffer.prefix(requestLength))
                self.inboundBuffer.removeFirst(requestLength)
                guard let request = String(data: requestData, encoding: .utf8) else {
                    self.channel.cancel()
                    return
                }

                // Only the WebSocket-upgrade branch consumes bytes left in
                // `inboundBuffer` after the slice: `receiveWebSocketFrame` drains them
                // first (issue #5678). The HTTP branches (`GET /health`,
                // `POST /sdk-events`, `GET /sdk-events`) each send their response and
                // then `connection.cancel()`, so any residual bytes after their request
                // are discarded with the connection — residual-carry there is out of
                // scope by design (AC4).
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
        channel.send(response) { [weak self] _ in
            self?.channel.cancel()
        }
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
        let response =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"ok\":true}\r\n"
        channel.send(Data(response.utf8)) { [weak self] _ in
            self?.channel.cancel()
        }
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
        channel.send(responseData) { [weak self] _ in
            self?.channel.cancel()
        }
    }

    private func handleWebSocketUpgrade(_ request: String) {
        // Extract Sec-WebSocket-Key
        guard let keyLine = request.split(separator: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") }),
            let key = keyLine.split(separator: ":").last?.trimmingCharacters(in: .whitespaces)
        else {
            print("[WebSocketConnection] Missing Sec-WebSocket-Key")
            channel.cancel()
            return
        }

        // Calculate accept key
        let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let acceptKey = Data((key + magic).utf8).sha1().base64EncodedString()

        // Send upgrade response
        let response = """
        HTTP/1.1 101 Switching Protocols\r
        Upgrade: websocket\r
        Connection: Upgrade\r
        Sec-WebSocket-Accept: \(acceptKey)\r
        \r

        """

        channel.send(Data(response.utf8)) { [weak self] error in
            if let error = error {
                print("[WebSocketConnection] Upgrade send error: \(error)")
                self?.closeConnection()
                return
            }

            self?.isWebSocketUpgraded = true
            self?.onUpgrade?()
            self?.sendConnectedEvent()
            self?.receiveWebSocketFrame()
        }
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

    /// Reads exactly `count` bytes for the frame parser, first draining any bytes
    /// already sitting in `inboundBuffer` from an earlier socket read — most
    /// importantly a WebSocket frame pipelined in the same TCP segment as the
    /// upgrade request, which would otherwise be stranded after the handshake
    /// slice and lost (issue #5678). Only when the buffer is short does it refill
    /// from the socket, reading precisely the shortfall so the buffer never grows
    /// beyond what a single frame read needs (per-frame size is already bounded by
    /// `frameReadLength`/`maxFramePayloadLength` in `readPayload`, and handshake
    /// residual by `maximumHTTPRequestLength`). All completions run on the server
    /// `queue`, so `inboundBuffer` needs no lock (same invariant as the handshake
    /// reader and the reassembly state). `onData` is invoked with exactly `count`
    /// bytes; on socket error/EOF the connection is closed and `onData` is not
    /// called.
    ///
    /// The buffered fast-path re-dispatches `onData` onto `queue` rather than
    /// calling it inline. Otherwise, when several frames are buffered together
    /// (the handshake reads up to `maximumHTTPRequestLength` in one segment, and
    /// coalesced pipelining can pack many frames into it), the whole
    /// parse → `readPayload` → `receiveFrameBytes` → `handleDataFrame` →
    /// `receiveWebSocketFrame` chain would recurse on a single call stack with no
    /// unwind between frames, risking stack exhaustion. The hop keeps per-frame
    /// stack depth bounded; ordering and the no-lock invariant are preserved
    /// because `queue` is the same serial queue every completion already runs on.
    private func receiveFrameBytes(_ count: Int, onData: @escaping (Data) -> Void) {
        if inboundBuffer.count >= count {
            let chunk = Data(inboundBuffer.prefix(count))
            inboundBuffer.removeFirst(count)
            queue.async { onData(chunk) }
            return
        }

        let needed = count - inboundBuffer.count
        channel.receive(minimumIncompleteLength: needed, maximumLength: needed) { [weak self] data, isComplete, error in
            guard let self = self else { return }

            if let error = error {
                print("[WebSocketConnection] Frame error: \(error)")
                self.closeConnection()
                return
            }

            // Fast path — the common post-upgrade case: nothing buffered and the
            // socket delivered the whole read in one piece. Hand it straight to
            // `onData` without routing through `inboundBuffer`. Buffering an
            // accepted frame here (up to `maxFramePayloadLength`) would add a
            // full-payload copy on the hot wire path and can spike RSS enough to
            // jetsam the runner, whereas the pre-refactor code passed complete
            // receive data through directly (issue #5678 review). This also covers
            // the final frame delivered together with `isComplete` (below).
            if self.inboundBuffer.isEmpty, let data = data, data.count == count {
                onData(data)
                return
            }

            // Consume whatever arrived before acting on EOF. The socket can
            // deliver the final `needed` bytes together with `isComplete` when a
            // client sends a complete frame and half-closes its write side, and
            // those bytes still complete a valid frame that must be parsed rather
            // than dropped (issue #5678 review). `minimumIncompleteLength: needed`
            // means a read shorter than `needed` only happens at EOF.
            if let data = data, !data.isEmpty {
                self.inboundBuffer.append(data)
            }

            if self.inboundBuffer.count >= count {
                // Enough bytes for this read; slice exactly `count`, keeping any
                // surplus for the next read. This completion is already an async
                // break, so `onData` runs inline here — only the buffered
                // fast-path above trampolines to bound recursion depth.
                let chunk = Data(self.inboundBuffer.prefix(count))
                self.inboundBuffer.removeFirst(count)
                onData(chunk)
                return
            }

            // Still short of a full frame. EOF here means the peer closed
            // mid-frame, so nothing more is coming — close.
            if isComplete {
                self.closeConnection()
                return
            }

            // No usable bytes yet and not at EOF — wait for the shortfall.
            self.receiveFrameBytes(count, onData: onData)
        }
    }

    private func receiveWebSocketFrame() {
        // Read first 2 bytes (header), draining the inbound buffer first so a
        // frame pipelined with the upgrade handshake is parsed (issue #5678).
        receiveFrameBytes(2) { [weak self] headerData in
            self?.parseWebSocketFrame(headerData)
        }
    }

    /// Test seam (issue #5678): inject bytes that were already received before
    /// frame reading began — e.g. a WebSocket frame pipelined in the same TCP
    /// segment as the upgrade request — into `inboundBuffer`, then start the frame
    /// reader exactly as the post-upgrade transition does. Because the whole frame
    /// is buffered, the drain path delivers it through the real parser with **no**
    /// `connection.receive`, so `WebSocketServerTests` can pin the residual-carry
    /// behavior deterministically, without depending on TCP segment coalescing.
    /// Internal, not private, so the test target can drive it via `@testable`.
    func deliverBufferedFramesForTesting(_ residual: Data) {
        inboundBuffer.append(residual)
        receiveWebSocketFrame()
    }

    private func parseWebSocketFrame(_ header: Data) {
        let byte0 = header[0]
        let byte1 = header[1]

        let isFinal = (byte0 & 0x80) != 0
        let opcode = byte0 & 0x0F
        let isMasked = (byte1 & 0x80) != 0
        let payloadLength = UInt64(byte1 & 0x7F)

        // Handle close frame. Send the close frame back, then cancel the socket
        // from the send completion so the peer receives the close before the TCP
        // teardown; the `.cancelled` transition fires `onClose` once (issue #5677).
        if opcode == 0x08 {
            sendCloseFrame()
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
                closeConnection()
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
        receiveFrameBytes(bytes) { [weak self] data in
            guard let self = self else { return }

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
    )
        -> Int?
    {
        guard payloadLength <= maxPayload else { return nil }
        return Int(payloadLength) + (isMasked ? 4 : 0)
    }

    /// Whether a data/continuation frame may be received, decided from the frame
    /// header alone.
    enum FramePreReadDecision: Equatable {
        /// The frame is admissible — receive its payload, then hand to `accumulate`.
        case read
        /// The frame is malformed or would overflow the reassembly budget — close
        /// the connection without receiving it.
        case reject(String)
    }

    /// Decides, from the frame header **before** any payload is received or
    /// unmasked, whether a data (0x1/0x2) or continuation (0x0) frame can legally
    /// be accepted into the current reassembly state. This mirrors `accumulate`'s
    /// rejection conditions but runs pre-read, so a malformed or oversized frame is
    /// rejected without ever allocating (and, when masked, copying) a payload the
    /// server would immediately discard — bounding per-connection memory to ~1× the
    /// cap instead of ~3× (issue #5674 review). Only frames this returns `.read`
    /// for reach `accumulate`, which stays the post-read authority for the accepted
    /// paths (defense in depth).
    static func preReadDataFrameDecision(
        opcode: UInt8,
        declaredPayloadLength: UInt64,
        inProgressOpcode: UInt8?,
        alreadyBuffered: Int,
        maxTotal: UInt64 = maxFramePayloadLength
    )
        -> FramePreReadDecision
    {
        switch opcode {
        case 0x01, 0x02:
            if inProgressOpcode != nil {
                return .reject(
                    "new data frame (opcode 0x\(String(opcode, radix: 16))) while a fragmented message is open"
                )
            }
            guard declaredPayloadLength <= maxTotal else {
                return .reject("frame payload exceeds \(maxTotal) bytes")
            }
            return .read
        case 0x00:
            guard inProgressOpcode != nil else {
                return .reject("continuation frame with no message in progress")
            }
            guard UInt64(alreadyBuffered) + declaredPayloadLength <= maxTotal else {
                return .reject("reassembled message exceeds \(maxTotal) bytes")
            }
            return .read
        default:
            return .reject("unsupported opcode 0x\(String(opcode, radix: 16))")
        }
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

    /// The outcome of applying one data/continuation frame to the reassembly
    /// buffer. Kept small so the fragmentation semantics can be unit-tested
    /// without a socket, mirroring `frameAction` (issue #5674).
    enum AccumulateResult: Equatable {
        /// The message is complete → deliver these fully-reassembled bytes.
        case deliver(Data)
        /// The fragment was appended in place; more frames are expected.
        case buffered
        /// A malformed fragmentation sequence or an exceeded total-size bound →
        /// the caller closes the connection rather than mis-delivering (§5.4).
        case protocolError(String)
    }

    /// Applies one data/continuation frame to the in-progress reassembly state,
    /// mutating the caller-owned `buffer` and `inProgressOpcode` **in place**
    /// (RFC 6455 §5.4):
    ///
    /// - A text/binary frame (0x1/0x2) with FIN=1 and nothing in progress is a
    ///   complete single-frame message → `.deliver` verbatim, untouched buffer
    ///   (no regression, and no copy).
    /// - A text/binary frame with FIN=0 starts a fragmented message: the payload
    ///   becomes the buffer and the opcode is recorded → `.buffered`.
    /// - A continuation frame (0x0) appends to the buffer; on FIN=1 the buffer is
    ///   handed off and reset → `.deliver`, otherwise `.buffered`.
    /// - A continuation with nothing in progress, or a new data frame while a
    ///   message is still open, is malformed → `.protocolError`.
    /// - The **total** reassembled size is bounded by `maxTotal` (the per-frame
    ///   `maxFramePayloadLength` applied cumulatively); exceeding it is a
    ///   `.protocolError` so the buffer cannot grow unboundedly.
    ///
    /// Appending into the caller's `buffer` via `inout` (rather than returning a
    /// freshly concatenated `Data`) keeps reassembly amortized O(total) instead of
    /// O(total²): a `var combined = accumulated; combined.append(...)` copy-on-write
    /// -copies the whole message-so-far for every continuation frame, so a legal
    /// large message split into many small fragments could pin the serial server
    /// queue and starve `/health` (issue #5674 review).
    static func accumulate(
        into buffer: inout Data,
        opcode: UInt8,
        isFinal: Bool,
        payload: Data,
        inProgressOpcode: inout UInt8?,
        maxTotal: UInt64 = maxFramePayloadLength
    )
        -> AccumulateResult
    {
        switch opcode {
        case 0x01, 0x02:
            // A new data frame is illegal while a fragmented message is still open.
            if inProgressOpcode != nil {
                return .protocolError(
                    "new data frame (opcode 0x\(String(opcode, radix: 16))) while a fragmented message is open"
                )
            }
            guard UInt64(payload.count) <= maxTotal else {
                return .protocolError("frame payload exceeds \(maxTotal) bytes")
            }
            if isFinal {
                // Single, unfragmented message — deliver directly, no buffering.
                return .deliver(payload)
            }
            // Start a fragmented message: the payload seeds the buffer.
            inProgressOpcode = opcode
            buffer = payload
            return .buffered

        case 0x00:
            // A continuation frame requires an in-progress message.
            guard inProgressOpcode != nil else {
                return .protocolError("continuation frame with no message in progress")
            }
            guard UInt64(buffer.count) + UInt64(payload.count) <= maxTotal else {
                return .protocolError("reassembled message exceeds \(maxTotal) bytes")
            }
            buffer.append(payload)
            guard isFinal else {
                return .buffered
            }
            // Final continuation — hand off the accumulated bytes and reset.
            let message = buffer
            buffer = Data()
            inProgressOpcode = nil
            return .deliver(message)

        default:
            // Reserved / unexpected data opcode (control frames never reach here).
            return .protocolError("unsupported opcode 0x\(String(opcode, radix: 16))")
        }
    }

    private func readPayload(length: UInt64, isMasked: Bool, opcode: UInt8, isFinal: Bool) {
        guard let totalLength = Self.frameReadLength(payloadLength: length, isMasked: isMasked) else {
            print("[WebSocketConnection] Frame payload too large (\(length) bytes), closing connection")
            closeConnection()
            return
        }

        // Reject any malformed or over-budget data/continuation frame from its
        // header, before receiving/unmasking its payload, so a malformed peer
        // cannot make the runner allocate a frame it would immediately discard
        // (§5.4; issue #5674 review). `accumulate` still enforces the same
        // conditions post-read as defense in depth for the accepted paths.
        if Self.isDataOrContinuation(opcode),
           case let .reject(reason) = Self.preReadDataFrameDecision(
               opcode: opcode,
               declaredPayloadLength: length,
               inProgressOpcode: fragmentedOpcode,
               alreadyBuffered: fragmentBuffer.count
           )
        {
            print("[WebSocketConnection] Fragmentation protocol error (pre-read): \(reason), closing connection")
            fragmentedOpcode = nil
            fragmentBuffer = Data()
            closeConnection()
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

        receiveFrameBytes(totalLength) { [weak self] data in
            guard let self = self else { return }

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
                self.channel.send(pongFrame) { _ in }
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
        switch WebSocketConnection.accumulate(
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
        // Cancel from the send completion — as the HTTP responders do — so the
        // close frame reaches the peer before the TCP teardown; the resulting
        // `.cancelled` transition fires `onClose` exactly once (issue #5677).
        channel.send(frame) { [weak self] _ in
            self?.channel.cancel()
        }
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
