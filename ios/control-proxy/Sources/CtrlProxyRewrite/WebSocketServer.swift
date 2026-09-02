import Foundation
import Network
import os

/// WebSocket server for CtrlProxy (RFC 6455 over TCP), plus the `/health` and
/// `/sdk-events` HTTP endpoints (handled per-connection).
///
/// Rewrite archetype: QUEUE-CONFINEMENT. Network.framework mandates a delivery
/// queue, so the accept/per-connection `queue` owns the listener lifecycle and
/// `nextConnectionId`; command execution is offloaded to a serial `commandQueue`
/// (issue #5374). The cross-thread-read collections — the connection registry and
/// the upgraded-client set — are lock-confined (`OSAllocatedUnfairLock`) rather than
/// queue-confined, so broadcasts and `hasConnectedClients` read a synchronous
/// snapshot without hopping. `@unchecked Sendable` is justified by exactly that: the
/// only bare mutable fields (`listener`, `nextConnectionId`) are queue-confined
/// (public `start`/`stop` funnel to `onqueue_` methods; the listener's own `.failed`
/// handler runs on `queue`), and everything else is a lock, an immutable `let`, or a
/// fresh-per-call coder.
///
/// vs. the reference this closes two races: `listener` (race #3) is now queue-
/// confined instead of a bare var mutated from `stop()` and the `.failed` handler,
/// and the presence callback (race #4) plus the SDK-updated hook are immutable
/// init-injected `@Sendable` closures instead of settable vars.
final class WebSocketServer: @unchecked Sendable {
    enum ServerError: Error {
        case alreadyRunning
        case failedToStart(Error)
        case encodingError
    }

    private let port: UInt16
    private let commandHandler: any CommandHandling
    private let perf: any PerfTracking
    private let frameContext: any FrameContextRecording
    /// Called with the `POST /sdk-events` body (SDK-hierarchy extraction lives here,
    /// filled in the SDK phase); forwarded to every connection.
    private let onSdkEventBatch: (@Sendable (Data) -> Void)?
    /// Supplies OSLog entries merged into `GET /sdk-events`; forwarded to connections.
    private let drainLogEvents: (@Sendable () -> [Data])?
    /// Fires on the zero↔non-zero connected-client transition (immutable — closes the
    /// reference's settable-var race #4). A transient HTTP request never toggles it.
    private let onClientPresenceChanged: (@Sendable (Bool) -> Void)?
    /// Test hook: when set, `broadcast` routes here instead of to live connections.
    private let broadcastSink: (@Sendable (Data) -> Void)?

    private let queue = DispatchQueue(label: "com.ctrlproxy.server")

    /// Serial command execution. Each dispatched command chains after the previous one's
    /// completion, so per-connection command ordering is preserved even though `handle` is
    /// now `async` (the reference used a single serial `commandQueue`; this is the
    /// async-native equivalent). Lock-guarded so `dispatchCommand` is callable from any
    /// thread, and non-blocking so the accept `queue` is freed the instant a command is
    /// enqueued rather than hopping onto a second serial queue (issue #5374).
    private let commandTail = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

    // Queue-confined (accessed only on `queue`).
    private var listener: NWListener?
    private var nextConnectionId = 1

    // Lock-confined synchronized collections (read from broadcast/presence off `queue`).
    private let connections = ConnectionRegistry<WebSocketConnection>()
    private let upgradedClientIds = OSAllocatedUnfairLock<Set<Int>>(initialState: [])
    /// Only connections that completed the RFC 6455 upgrade. HTTP probes (`/health`,
    /// `/sdk-events`) share the accept path but must never receive framed WebSocket
    /// broadcasts (#5830). A responder registry (not the id set) so tests can pin the
    /// routing invariant with a fake responder.
    private let upgradedConnections = ConnectionRegistry<any WebSocketResponding>()

    init(
        port: UInt16 = 8765,
        commandHandler: any CommandHandling,
        perf: any PerfTracking,
        frameContext: any FrameContextRecording,
        onSdkEventBatch: (@Sendable (Data) -> Void)? = nil,
        drainLogEvents: (@Sendable () -> [Data])? = nil,
        onClientPresenceChanged: (@Sendable (Bool) -> Void)? = nil,
        broadcastSink: (@Sendable (Data) -> Void)? = nil
    ) {
        self.port = port
        self.commandHandler = commandHandler
        self.perf = perf
        self.frameContext = frameContext
        self.onSdkEventBatch = onSdkEventBatch
        self.drainLogEvents = drainLogEvents
        self.onClientPresenceChanged = onClientPresenceChanged
        self.broadcastSink = broadcastSink
    }

    var isRunning: Bool {
        queue.sync { listener != nil }
    }

    /// Whether at least one WebSocket client is currently connected (upgraded).
    var hasConnectedClients: Bool {
        upgradedClientIds.withLock { !$0.isEmpty }
    }

    // MARK: - Lifecycle

    func start() throws {
        dispatchPrecondition(condition: .notOnQueue(queue))
        try queue.sync { try onqueue_start() }
    }

    private func onqueue_start() throws {
        dispatchPrecondition(condition: .onQueue(queue))
        guard listener == nil else {
            throw ServerError.alreadyRunning
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true

        let newListener: NWListener
        do {
            newListener = try NWListener(using: parameters, on: NWEndpoint.Port(integerLiteral: port))
        } catch {
            throw ServerError.failedToStart(error)
        }

        newListener.stateUpdateHandler = { [weak self] state in
            // Delivered on `queue` (listener.start(queue:)), so the self-stop runs on-queue.
            switch state {
            case let .failed(error):
                print("[WebSocketServer] Server failed: \(error)")
                self?.onqueue_stop()
            case .ready, .cancelled:
                break
            default:
                break
            }
        }
        newListener.newConnectionHandler = { [weak self] connection in
            self?.handleNewConnection(connection)
        }
        listener = newListener
        newListener.start(queue: queue)
    }

    func stop() {
        dispatchPrecondition(condition: .notOnQueue(queue))
        queue.sync { onqueue_stop() }
    }

    private func onqueue_stop() {
        dispatchPrecondition(condition: .onQueue(queue))
        _ = upgradedConnections.removeAll()
        connections.removeAll().forEach { $0.close() }
        listener?.cancel()
        listener = nil
    }

    // MARK: - Connection handling

    private func handleNewConnection(_ nwConnection: NWConnection) {
        dispatchPrecondition(condition: .onQueue(queue))
        let connectionId = nextConnectionId
        nextConnectionId += 1

        let connection = WebSocketConnection(
            id: connectionId,
            connection: nwConnection,
            queue: queue,
            boundPort: port,
            onSdkEventBatch: onSdkEventBatch,
            drainLogEvents: drainLogEvents,
            onUpgrade: { [weak self] in self?.clientDidUpgrade(connectionId) },
            onMessage: { [weak self] message in self?.handleMessage(message, connectionId: connectionId) },
            onClose: { [weak self] in
                self?.connections.removeValue(forId: connectionId)
                self?.clientDidDisconnect(connectionId)
            }
        )
        connections.set(connection, forId: connectionId)
        connection.start()
    }

    /// Records a completed upgrade, firing the presence hook only on the zero →
    /// non-zero transition. Lock-confined, so callable from any thread. Also promotes
    /// the connection into the broadcast-eligible set so only upgraded clients — never
    /// HTTP probes — receive framed broadcasts (#5830).
    func clientDidUpgrade(_ id: Int) {
        if let connection = connections.value(forId: id) {
            upgradedConnections.set(connection, forId: id)
        }
        let wasEmpty = upgradedClientIds.withLock { ids -> Bool in
            let wasEmpty = ids.isEmpty
            ids.insert(id)
            return wasEmpty
        }
        if wasEmpty {
            onClientPresenceChanged?(true)
        }
    }

    /// Records a close, firing the presence hook only on the non-zero → zero
    /// transition. A never-upgraded (HTTP-only) connection is a no-op here, so
    /// `/health` probes never toggle presence.
    func clientDidDisconnect(_ id: Int) {
        upgradedConnections.removeValue(forId: id)
        let (wasPresent, nowEmpty) = upgradedClientIds.withLock { ids -> (Bool, Bool) in
            let wasPresent = !ids.isEmpty
            ids.remove(id)
            return (wasPresent, ids.isEmpty)
        }
        if wasPresent, nowEmpty {
            onClientPresenceChanged?(false)
        }
    }

    private func handleMessage(_ data: Data, connectionId: Int) {
        guard let connection = connections.value(forId: connectionId) else { return }
        dispatchCommand(data, responder: connection)
    }

    /// Enqueues one command onto the serial task-chain so it runs off the accept `queue` —
    /// a slow XCUITest walk / screenshot / SDK call cannot starve `/health` or new accepts
    /// (issue #5374) — while `await previous?.value` keeps commands strictly ordered.
    /// `responder` is captured strongly so it outlives the hop; enqueuing is non-blocking.
    func dispatchCommand(_ data: Data, responder: any WebSocketResponding) {
        commandTail.withLock { tail in
            let previous = tail
            tail = Task { [weak self] in
                await previous?.value
                await self?.handleMessage(data, responder: responder)
            }
        }
    }

    /// Decode → dispatch → encode → send, recovering the correlation id and emitting a
    /// structured error envelope on a decode failure. The decode→handle→flush→encode core is
    /// bracketed in `perf.withScope` so the task-local perf call-tree is bound for this
    /// command and every `serial`/`track` inside `handle` (including across its `await`s into
    /// `@MainActor` collaborators, same task) accumulates — without it every perf call is a
    /// silent no-op (§9.5). Runs on the serial command task-chain.
    func handleMessage(_ data: Data, responder: any WebSocketResponding) async {
        do {
            let request = try JSONDecoder().decode(WebSocketRequest.self, from: data)
            print("[WebSocketServer] Received request type=\(request.typeString) requestId=\(request.requestId ?? "nil")")

            let responseData = try await perf.withScope {
                self.perf.serial("handleRequest:\(request.typeString)")
                let startTime = Date()
                let response = await self.commandHandler.handle(request)
                let totalTimeMs = Int64(Date().timeIntervalSince(startTime) * 1000)
                self.perf.end()

                let perfTiming = self.flushPerfTiming()
                return try self.encodeResponse(response, totalTimeMs: totalTimeMs, perfTiming: perfTiming)
            }
            responder.send(responseData)
        } catch {
            print("[WebSocketServer] Error handling message: \(error)")
            perf.clear()
            let requestId = WireError.extractRequestId(from: data)
            responder.send(ErrorResponse.build(requestId: requestId, error: error))
        }
    }

    /// Flush accumulated perf timing data into a single `PerfTiming` entry.
    private func flushPerfTiming() -> PerfTiming? {
        guard let timings = perf.flush(), !timings.isEmpty else {
            return nil
        }
        if timings.count == 1 {
            return timings[0]
        }
        let totalDuration = timings.reduce(0) { $0 + $1.durationMs }
        return PerfTiming(name: "total", durationMs: totalDuration, children: timings)
    }

    private func encodeResponse(
        _ response: any WebSocketResponsePayload,
        totalTimeMs: Int64,
        perfTiming: PerfTiming?
    ) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys

        if var wsResponse = response as? WebSocketResponse {
            // Inject perfTiming if present and the response doesn't already carry it;
            // preserve `text` (e.g. clipboard get) during the rebuild.
            if perfTiming != nil, wsResponse.perfTiming == nil {
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
            if perfTiming != nil, hierarchyResponse.perfTiming == nil {
                hierarchyResponse = HierarchyUpdateResponse(
                    requestId: hierarchyResponse.requestId,
                    data: hierarchyResponse.data,
                    perfTiming: perfTiming,
                    error: hierarchyResponse.error,
                    frameContext: hierarchyResponse.frameContext
                )
            }
            return try encoder.encode(hierarchyResponse)
        } else {
            // Every other payload (ScreenshotResponse and the CommandHandler-built
            // envelopes) encodes straight through — no perfTiming injection, matching
            // the reference's ScreenshotResponse / Encodable-fallback branches.
            return try response.encoded(with: encoder)
        }
    }

    // MARK: - Broadcast

    /// Broadcast a message to every upgraded WebSocket client. Never routes to
    /// HTTP-only connections (`/health`, `/sdk-events` probes), which share the
    /// accept path but never complete the RFC 6455 upgrade (#5830).
    func broadcast(_ data: Data) {
        if let broadcastSink {
            broadcastSink(data)
            return
        }
        for connection in upgradedConnections.values() {
            connection.send(data)
        }
    }

    /// Test seam for pinning the broadcast-routing invariant without opening a real
    /// socket. Production upgrades are registered by `clientDidUpgrade` (#5830).
    func registerUpgradedResponderForTesting(_ responder: any WebSocketResponding, id: Int) {
        upgradedConnections.set(responder, forId: id)
    }

    /// Broadcast a hierarchy update push (requestId: nil), stamping the frameContext.
    func broadcastHierarchyUpdate(_ hierarchy: ViewHierarchy) {
        let context = frameContext.recordTransition(to: hierarchy)
        let response = HierarchyUpdateResponse(
            requestId: nil,
            data: hierarchy,
            perfTiming: nil,
            frameContext: context
        )
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            broadcast(try encoder.encode(response))
        } catch {
            print("[WebSocketServer] Failed to encode hierarchy update: \(error)")
        }
    }

    /// Broadcast a performance update push to all connected clients. Skips the encode
    /// when no clients are connected, matching the reference.
    func broadcastPerformanceUpdate(_ snapshot: PerformanceSnapshot) {
        guard !connections.isEmpty else { return }

        let response = PerformanceUpdateResponse(data: snapshot)
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            broadcast(try encoder.encode(response))
        } catch {
            print("[WebSocketServer] Failed to encode performance update: \(error)")
        }
    }
}
