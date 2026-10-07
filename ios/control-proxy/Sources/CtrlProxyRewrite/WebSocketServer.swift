import Foundation
import Network
import os

struct InFlightRunnerCommand: Sendable, Equatable {
    let type: String
    let requestId: String?
    let startedAtMs: Int64
    let deadlineMs: Int64?
}

enum CommandAdmissionDecision: Equatable {
    case queue
    case busy(blockingType: String, elapsedMs: Int64, deadlineRemainingMs: Int64?)
}

/// Pure admission rule. The caller snapshots state and time under the dispatch lock.
func admissionDecision(
    inFlight: InFlightRunnerCommand?, nowMs: Int64, budgetMs: Int64
)
    -> CommandAdmissionDecision
{
    guard let inFlight else { return .queue }
    let elapsedMs = max(0, nowMs - inFlight.startedAtMs)
    return elapsedMs > budgetMs
        ? .busy(
            blockingType: inFlight.type, elapsedMs: elapsedMs,
            deadlineRemainingMs: inFlight.deadlineMs.map { $0 - nowMs }
        )
        : .queue
}

enum GestureExecutionBound {
    static let minBoundMs: Int64 = 250
    static let responseReserveMs: Int64 = 500
}

/// Optional client transport budget carried on every request envelope (#10084). It decodes
/// exactly like `RequestSwipe.timeoutMs`: only a positive integer counts; anything else
/// (missing, zero, negative, string, bool, fraction) leaves the legacy no-deadline path.
struct CommandDeadlineEnvelope: Decodable, Sendable {
    let timeoutMs: Int?

    private enum CodingKeys: String, CodingKey { case timeoutMs }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = try? values.decode(Int.self, forKey: .timeoutMs)
        timeoutMs = decoded.flatMap { $0 > 0 ? $0 : nil }
    }

    /// Absolute monotonic deadline for a request received at `receivedAtMs`, or nil when the
    /// envelope carries no valid budget (an older host). Saturates instead of overflowing.
    static func deadlineMs(from data: Data, receivedAtMs: Int64) -> Int64? {
        guard let timeoutMs = (try? JSONDecoder().decode(Self.self, from: data))?.timeoutMs else {
            return nil
        }
        let (deadline, overflow) = receivedAtMs.addingReportingOverflow(Int64(timeoutMs))
        return overflow ? Int64.max : deadline
    }
}

/// Whether a queued command is dropped instead of started. A command whose sender has stopped
/// waiting must not land late on whatever screen is showing by then (#10084).
enum QueuedCommandDisposition: Equatable {
    case execute
    /// The sender's connection closed while the command waited; nobody can receive a reply.
    case connectionClosed
    /// The sender's wire deadline passed while the command waited behind earlier commands.
    case expired(queuedMs: Int64, timeoutMs: Int64)
}

/// Pure pre-execution rule, evaluated when a queued command reaches the head of the chain.
func queuedCommandDisposition(
    connectionOpen: Bool, deadlineMs: Int64?, receivedAtMs: Int64, nowMs: Int64
)
    -> QueuedCommandDisposition
{
    guard connectionOpen else { return .connectionClosed }
    guard let deadlineMs, nowMs >= deadlineMs else { return .execute }
    return .expired(queuedMs: max(0, nowMs - receivedAtMs), timeoutMs: max(0, deadlineMs - receivedAtMs))
}

/// Every request may carry a wire deadline (#10084), but only request_swipe bounds its
/// execution with it. Tap/drag/pinch and the other commands can legitimately run long, so
/// for them the deadline only decides whether a queued command starts at all.
func gestureExecutionBoundMs(deadlineMs: Int64?, executionStartedAtMs: Int64) -> Int64? {
    guard let deadlineMs else { return nil }
    return max(
        GestureExecutionBound.minBoundMs,
        deadlineMs - executionStartedAtMs - GestureExecutionBound.responseReserveMs
    )
}

private enum GestureExecutionWinner: Sendable {
    case handler
    case bound(phase: String, elapsedMs: Int64)
}

/// Exactly one racer resumes the continuation; losing tasks never send a response.
private final class GestureExecutionResolution: Sendable {
    private struct State {
        var winner: GestureExecutionWinner?
        var continuation: CheckedContinuation<GestureExecutionWinner, Never>?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    func wait() async -> GestureExecutionWinner {
        await withCheckedContinuation { continuation in
            let winner = state.withLock { state -> GestureExecutionWinner? in
                if let winner = state.winner { return winner }
                state.continuation = continuation
                return nil
            }
            if let winner { continuation.resume(returning: winner) }
        }
    }

    func resolve(_ value: @Sendable () -> GestureExecutionWinner) {
        let result = state.withLock { state -> (
            GestureExecutionWinner,
            CheckedContinuation<GestureExecutionWinner, Never>?
        )? in
            guard state.winner == nil else { return nil }
            // Compute only for the first resolver, including bound diagnostics/logging.
            let winner = value()
            state.winner = winner
            let continuation = state.continuation
            state.continuation = nil
            return (winner, continuation)
        }
        if let (winner, continuation) = result { continuation?.resume(returning: winner) }
    }
}

/// Coordinates failures recorded while one WebSocket command is in flight.
///
/// The server executes commands serially, so one lock-confined slot is sufficient. The
/// coordinator deliberately knows nothing about the framework that records a failure: callers
/// translate failures to strings at the boundary, keeping the production target framework-free.
public final class CommandFailureCoordinator: Sendable {
    static let maxFailures = 16
    static let maxDescriptionBytes = 4096
    private static let truncationIndicator = "Additional command failures truncated"

    private struct InFlightCommand: Sendable {
        let requestId: String?
        var failures: [String] = []
        var descriptionBytes = 0
        var truncated = false
    }

    private let inFlightCommand = OSAllocatedUnfairLock<InFlightCommand?>(initialState: nil)

    public init() {}

    public func begin(requestId: String?) {
        inFlightCommand.withLock { $0 = InFlightCommand(requestId: requestId) }
    }

    /// Records a failure for the current command, returning whether the caller should deflect it.
    public func recordDeflectedFailure(_ description: String) -> Bool {
        inFlightCommand.withLock { state in
            guard var command = state else { return false }
            if !command.truncated {
                let remaining = Self.maxDescriptionBytes - Self.truncationIndicator.utf8.count
                    - command.descriptionBytes
                if command.failures.count == Self.maxFailures || description.utf8.count > remaining {
                    if remaining > 0, command.failures.count < Self.maxFailures {
                        var prefix = ""
                        var prefixBytes = 0
                        for scalar in description.unicodeScalars {
                            let scalarBytes = String(scalar).utf8.count
                            if prefixBytes + scalarBytes > remaining { break }
                            prefix.unicodeScalars.append(scalar)
                            prefixBytes += scalarBytes
                        }
                        if !prefix.isEmpty {
                            command.failures.append(prefix)
                            command.descriptionBytes += prefixBytes
                        }
                    }
                    command.failures.append(Self.truncationIndicator)
                    command.truncated = true
                } else {
                    command.failures.append(description)
                    command.descriptionBytes += description.utf8.count
                }
            }
            state = command
            return true
        }
    }

    /// Returns all failures and closes the command window under the same lock.
    public func finish() -> [String] {
        inFlightCommand.withLock { state in
            guard let command = state else { return [] }
            let failures = command.failures
            state = nil
            return failures
        }
    }
}

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
    private static let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "WebSocketServer")

    static func makeLoopbackListener(port: UInt16) throws -> NWListener {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(
            host: "127.0.0.1", port: NWEndpoint.Port(integerLiteral: port)
        )
        return try NWListener(using: parameters)
    }

    enum ServerError: Error {
        case alreadyRunning
        case failedToStart(Error)
        case encodingError
    }

    private let listenerFactory: @Sendable (UInt16) throws -> any ServerListening
    private let port: UInt16
    private let commandHandler: any CommandHandling
    private let perf: any PerfTracking
    private let frameContext: any FrameContextRecording
    private let failureCoordinator: CommandFailureCoordinator?
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

    /// Serial command execution and the active command share one lock. The task tail
    /// preserves ordering; the active command snapshot lets the receive queue make
    /// an admission decision without waiting for an XCUITest call (issue #5374).
    private struct CommandState {
        var tail: Task<Void, Never>?
        var inFlight: InFlightRunnerCommand?
    }

    /// Normal multi-second text entry, gestures, and app launches can make concurrent
    /// observe/hierarchy requests wait successfully. A 3s limit would reject them;
    /// the main-thread wedge this guards against lasted 45-51s, so >10s is pathological.
    static let defaultBusyBudgetMs: Int64 = 10000
    private let busyBudgetMs: Int64
    private let timer: any ProxyTimer
    private let gestureLogSink: any GestureLogSink
    private let monotonicNowMs: @Sendable () -> Int64
    private let commandState = OSAllocatedUnfairLock<CommandState>(initialState: CommandState())

    // Queue-confined (accessed only on `queue`).
    private var listener: (any ServerListening)?
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
        failureCoordinator: CommandFailureCoordinator? = nil,
        onSdkEventBatch: (@Sendable (Data) -> Void)? = nil,
        drainLogEvents: (@Sendable () -> [Data])? = nil,
        onClientPresenceChanged: (@Sendable (Bool) -> Void)? = nil,
        broadcastSink: (@Sendable (Data) -> Void)? = nil,
        busyBudgetMs: Int64 = WebSocketServer.defaultBusyBudgetMs,
        monotonicNowMs: @escaping @Sendable () -> Int64 = {
            Int64(ProcessInfo.processInfo.systemUptime * 1000)
        },
        gestureLogSink: any GestureLogSink = SystemGestureLogSink(),
        timer: any ProxyTimer = SystemTimer(),
        listenerFactory: @escaping @Sendable (UInt16) throws -> any ServerListening = {
            try WebSocketServer.makeLoopbackListener(port: $0)
        }
    ) {
        self.listenerFactory = listenerFactory
        self.port = port
        self.commandHandler = commandHandler
        self.perf = perf
        self.frameContext = frameContext
        self.failureCoordinator = failureCoordinator
        self.onSdkEventBatch = onSdkEventBatch
        self.drainLogEvents = drainLogEvents
        self.onClientPresenceChanged = onClientPresenceChanged
        self.broadcastSink = broadcastSink
        self.busyBudgetMs = busyBudgetMs
        self.monotonicNowMs = monotonicNowMs
        self.gestureLogSink = gestureLogSink
        self.timer = timer
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

        let newListener: any ServerListening
        do {
            newListener = try listenerFactory(port)
        } catch {
            Self.logger.warning("CtrlProxy listener failed to bind: \(error)")
            throw ServerError.failedToStart(error)
        }

        newListener.stateUpdateHandler = { [weak self, weak newListener] state in
            guard let self, let newListener, self.listener === newListener else { return }
            // Delivered on `queue` (listener.start(queue:)), so the self-stop runs on-queue.
            switch state {
            case let .failed(error):
                Self.logger.warning("CtrlProxy listener failed: \(error)")
                self.onqueue_stop()
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
        let hadClients = upgradedClientIds.withLock { ids in
            let hadClients = !ids.isEmpty
            ids.removeAll()
            return hadClients
        }
        _ = upgradedConnections.removeAll()
        connections.removeAll().forEach { $0.close() }
        listener?.cancel()
        listener = nil
        if hadClients {
            onClientPresenceChanged?(false)
        }
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
        dispatchCommand(data, responder: connection, isConnectionOpen: { [weak self] in
            self?.connections.value(forId: connectionId) != nil
        })
    }

    /// Answers (or, with no connection left, only logs) a queued command dropped before it
    /// started. The busy guard is untouched: the command never became the in-flight one.
    private func rejectQueuedCommand(
        _ data: Data, type: String, disposition: QueuedCommandDisposition, responder: any WebSocketResponding
    ) {
        switch disposition {
        case .execute:
            return
        case .connectionClosed:
            // The sender is gone, so there is nobody to answer; the drop itself is the outcome.
            Self.logger.info("Dropped queued \(type, privacy: .public): client connection closed before it started")
        case let .expired(queuedMs, timeoutMs):
            Self.logger.info("Dropped queued \(type, privacy: .public): deadline passed after \(queuedMs)ms queued")
            let error = CommandError.expiredBeforeExecution(command: type, timeoutMs: timeoutMs, queuedMs: queuedMs)
            let responseType = (try? JSONDecoder().decode(WebSocketRequest.self, from: data))?
                .requestType.responseType.rawValue ?? "error"
            let response = WebSocketResponse.error(
                type: responseType, requestId: WireError.extractRequestId(from: data),
                error: error.errorDescription ?? "Command expired before execution", totalTimeMs: queuedMs
            )
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = .sortedKeys
                try responder.send(encoder.encode(response))
            } catch {
                print("[WebSocketServer] Failed to encode expired-command response: \(error)")
            }
        }
    }

    /// Enqueues one command onto the serial task-chain so it runs off the accept `queue` —
    /// a slow XCUITest walk / screenshot / SDK call cannot starve `/health` or new accepts
    /// (issue #5374) — while `await previous?.value` keeps commands strictly ordered.
    /// `responder` is captured strongly so it outlives the hop; enqueuing is non-blocking.
    ///
    /// `isConnectionOpen` reports whether the sender is still connected; a queued command whose
    /// connection closed before it reached the head of the chain is dropped unstarted (#10084).
    func dispatchCommand(
        _ data: Data, responder: any WebSocketResponding,
        isConnectionOpen: @escaping @Sendable () -> Bool = { true }
    ) {
        // Network.framework delivers this call on the server queue, never the main actor.
        // Inspect the envelope and its optional budget here; malformed requests still take the
        // normal queued decode/error path. Keep send outside the lock and task-chain.
        let receivedAtMs = monotonicNowMs()
        let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let type = envelope?["type"] as? String ?? "unknown"
        let requestId = envelope?["requestId"] as? String
        // Any request may carry the client's transport budget so queue wait counts against it.
        // Swipe keeps enforcing it in its handler (which also bounds its execution and reports
        // the established swipe deadline error); every other type is gated before it starts.
        let wireDeadlineMs = CommandDeadlineEnvelope.deadlineMs(from: data, receivedAtMs: receivedAtMs)
        let isSwipe = type == "request_swipe"
        let deadlineMs: Int64? = isSwipe ? wireDeadlineMs : nil
        let queueDeadlineMs: Int64? = isSwipe ? nil : wireDeadlineMs
        let decision = commandState.withLock { state -> CommandAdmissionDecision in
            let decision = admissionDecision(
                inFlight: state.inFlight, nowMs: monotonicNowMs(), budgetMs: busyBudgetMs
            )
            guard decision == .queue else { return decision }
            let previous = state.tail
            state.tail = Task { [weak self] in
                await previous?.value
                guard let self else { return }
                let disposition = queuedCommandDisposition(
                    connectionOpen: isConnectionOpen(), deadlineMs: queueDeadlineMs,
                    receivedAtMs: receivedAtMs, nowMs: self.monotonicNowMs()
                )
                guard disposition == .execute else {
                    self.rejectQueuedCommand(data, type: type, disposition: disposition, responder: responder)
                    return
                }
                self.commandState.withLock { state in
                    state.inFlight = InFlightRunnerCommand(
                        type: type, requestId: requestId, startedAtMs: self.monotonicNowMs(),
                        deadlineMs: deadlineMs
                    )
                }
                await self.handleMessage(
                    data, responder: responder, deadlineMs: deadlineMs, receivedAtMs: receivedAtMs,
                    onCompleted: { self.commandState.withLock { $0.inFlight = nil } }
                )
            }
            return .queue
        }
        if case let .busy(blockingType, elapsedMs, deadlineRemainingMs) = decision {
            let response = WebSocketResponse(
                type: "error", requestId: requestId, success: false, error: "runner_busy",
                blockingCommandType: blockingType, blockingElapsedMs: elapsedMs,
                blockingDeadlineRemainingMs: deadlineRemainingMs
            )
            do {
                try responder.send(JSONEncoder().encode(response))
            } catch {
                print("[WebSocketServer] Failed to encode runner_busy response: \(error)")
            }
        }
    }

    /// Decode → dispatch → encode → send, recovering the correlation id and emitting a
    /// structured error envelope on a decode failure. The decode→handle→flush→encode core is
    /// bracketed in `perf.withScope` so the task-local perf call-tree is bound for this
    /// command and every `serial`/`track` inside `handle` (including across its `await`s into
    /// `@MainActor` collaborators, same task) accumulates — without it every perf call is a
    /// silent no-op (§9.5). Runs on the serial command task-chain.
    func handleMessage(
        _ data: Data, responder: any WebSocketResponding, deadlineMs: Int64? = nil, receivedAtMs: Int64? = nil,
        onCompleted: @Sendable () -> Void = {}
    )
        async
    {
        let executionStartedAtMs = monotonicNowMs()
        let inFlightRequestId = failureCoordinator == nil ? nil : WireError.extractRequestId(from: data)
        failureCoordinator?.begin(requestId: inFlightRequestId)
        let earlyResponseSent = OSAllocatedUnfairLock(initialState: false)
        do {
            let request = try JSONDecoder().decode(WebSocketRequest.self, from: data)
            print(
                "[WebSocketServer] Received request type=\(request.typeString) requestId=\(request.requestId ?? "nil")"
            )

            let gestureCommands: Set<String> = [
                "request_swipe",
                "request_tap_coordinates",
                "request_drag",
                "request_pinch",
                "request_press_key",
            ]
            let diagnostics = gestureCommands.contains(request.typeString) ? GesturePhaseDiagnostics(
                command: request.typeString, receivedAtMs: receivedAtMs ?? executionStartedAtMs,
                deadlineMs: deadlineMs, now: monotonicNowMs, sink: gestureLogSink
            ) : nil
            diagnostics?.begin("executionPreparation", at: executionStartedAtMs)
            let (response, responseData) = try await GesturePhaseDiagnostics.$current.withValue(diagnostics) {
                try await perf.withScope {
                    self.perf.serial("handleRequest:\(request.typeString)")
                    let startTime = Date()
                    let response: any WebSocketResponsePayload
                    if let boundMs = gestureExecutionBoundMs(
                        deadlineMs: deadlineMs, executionStartedAtMs: executionStartedAtMs
                    ) {
                        let result = await self.handleBoundedCommand(
                            request, deadlineMs: deadlineMs, boundMs: boundMs,
                            executionStartedAtMs: executionStartedAtMs,
                            diagnostics: diagnostics, responder: responder
                        )
                        response = result.response
                        earlyResponseSent.withLock { $0 = result.boundHit }
                    } else {
                        response = await self.commandHandler.handle(
                            request, deadlineMs: deadlineMs, monotonicNowMs: self.monotonicNowMs
                        )
                    }
                    let totalTimeMs = Int64(Date().timeIntervalSince(startTime) * 1000)
                    self.perf.end()

                    _ = diagnostics?.finish()
                    let flushed = self.flushPerfTiming()
                    let perfTiming = diagnostics?.attaching(to: flushed) ?? flushed
                    let data: Data
                    if earlyResponseSent.withLock({ $0 }) {
                        data = Data()
                    } else {
                        data = try self.encodeResponse(response, totalTimeMs: totalTimeMs, perfTiming: perfTiming)
                    }
                    return (response, data)
                }
            }
            let deflectedFailures = failureCoordinator?.finish() ?? []
            if earlyResponseSent.withLock({ $0 }) {
                onCompleted()
                return
            }
            if deflectedFailures.isEmpty {
                onCompleted()
                responder.send(responseData)
            } else {
                let existingError = (response as? WebSocketResponse).flatMap { $0.success == false ? $0.error : nil }
                let error = DeflectedCommandError(
                    failures: deflectedFailures, underlyingMessage: existingError
                )
                if let original = response as? WebSocketResponse, existingError != nil {
                    // Decode the already-encoded envelope so injected timing is retained.
                    let encoded = try JSONDecoder().decode(WebSocketResponse.self, from: responseData)
                    var deflected = WebSocketResponse(
                        type: original.type,
                        timestamp: original.timestamp,
                        requestId: original.requestId,
                        success: false,
                        totalTimeMs: encoded.totalTimeMs,
                        error: error.errorDescription,
                        blockingCommandType: original.blockingCommandType,
                        blockingElapsedMs: original.blockingElapsedMs,
                        blockingDeadlineRemainingMs: original.blockingDeadlineRemainingMs,
                        text: original.text,
                        perfTiming: encoded.perfTiming,
                        pinchPath: original.pinchPath,
                        resolvedStore: original.resolvedStore
                    )
                    deflected.effectiveValueDiffers = original.effectiveValueDiffers
                    let data = try JSONEncoder().encode(deflected)
                    onCompleted()
                    responder.send(data)
                } else {
                    onCompleted()
                    responder.send(ErrorResponse.build(requestId: inFlightRequestId, error: error))
                }
            }
        } catch {
            print("[WebSocketServer] Error handling message: \(error)")
            perf.clear()
            let deflectedFailures = failureCoordinator?.finish() ?? []
            let responseError: any Error = if deflectedFailures.isEmpty {
                error
            } else {
                DeflectedCommandError(
                    failures: deflectedFailures,
                    underlyingMessage: WireError.message(for: error)
                )
            }
            let requestId = WireError.extractRequestId(from: data)
            onCompleted()
            if !earlyResponseSent.withLock({ $0 }) {
                responder.send(ErrorResponse.build(requestId: requestId, error: responseError))
            }
        }
    }

    /// XCUITest is main-thread-confined: its synchronous swipe cannot be cancelled and
    /// blocks the main actor. Keep the serial chain and in-flight guard held until it
    /// returns; releasing them early would silently pile commands onto the blocked actor.
    /// The timeout is a response bound, not an interruption of the underlying call.
    private func handleBoundedCommand(
        _ request: WebSocketRequest, deadlineMs: Int64?, boundMs: Int64, executionStartedAtMs: Int64,
        diagnostics: GesturePhaseDiagnostics?, responder: any WebSocketResponding
    )
        async -> (response: any WebSocketResponsePayload, boundHit: Bool)
    {
        // Unstructured Tasks inherit gesture/perf TaskLocals without a task group's
        // mandatory child join preventing the early timeout response.
        let resolution = GestureExecutionResolution()
        let handler = Task {
            let response = await self.commandHandler.handle(
                request, deadlineMs: deadlineMs, monotonicNowMs: self.monotonicNowMs
            )
            resolution.resolve { .handler }
            return response
        }
        let watchdog = Task {
            // SystemTimer.schedule dispatches to the BLOCKED main queue: it cannot
            // be a watchdog. ProxyTimer.wait uses Task.sleep on the cooperative pool.
            let remainingMs = max(0, boundMs - (self.monotonicNowMs() - executionStartedAtMs))
            await self.timer.wait(milliseconds: remainingMs)
            guard !Task.isCancelled else { return }
            resolution.resolve {
                let hit = diagnostics?.markBoundExceeded(boundMs: boundMs)
                return .bound(phase: hit?.phase ?? "executionPreparation", elapsedMs: hit?.elapsedMs ?? boundMs)
            }
        }
        // The lock stores an early winner if either task finishes before wait registers.
        let winner = await resolution.wait()
        switch winner {
        case .handler:
            watchdog.cancel()
            return (await handler.value, false)
        case let .bound(phase, elapsedMs):
            let error = CommandError.gestureBoundExceeded(
                command: request.typeString, phase: phase, boundMs: boundMs, elapsedMs: elapsedMs
            )
            let response = WebSocketResponse.error(
                type: request.requestType.responseType.rawValue,
                requestId: request.requestId, error: error.errorDescription ?? "Gesture execution bound exceeded"
            )
            do {
                try responder.send(JSONEncoder().encode(response))
            } catch {
                print("[WebSocketServer] Failed to encode gesture bound response: \(error)")
            }
            // Await the real task and discard its late response. The caller still flushes
            // perf, finishes diagnostics/failure coordination, then clears the busy guard.
            return (await handler.value, true)
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
    )
        throws -> Data
    {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys

        if var wsResponse = response as? WebSocketResponse {
            // Inject perfTiming if present and the response doesn't already carry it;
            // preserve the full response envelope during the copy.
            if let perfTiming, wsResponse.perfTiming == nil {
                wsResponse = wsResponse.withPerfTiming(perfTiming, totalTimeMs: totalTimeMs)
            }
            return try encoder.encode(wsResponse)
        } else if var hierarchyResponse = response as? HierarchyUpdateResponse {
            if let perfTiming, hierarchyResponse.perfTiming == nil {
                hierarchyResponse = hierarchyResponse.withPerfTiming(perfTiming)
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
            try broadcast(encoder.encode(response))
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
            try broadcast(encoder.encode(response))
        } catch {
            print("[WebSocketServer] Failed to encode performance update: \(error)")
        }
    }
}

private struct DeflectedCommandError: LocalizedError, Sendable {
    let failures: [String]
    let underlyingMessage: String?

    init(failures: [String], underlyingMessage: String? = nil) {
        self.failures = failures
        self.underlyingMessage = underlyingMessage
    }

    var errorDescription: String? {
        let failureSummary = failures.joined(separator: "\n")
        if let underlyingMessage {
            return "\(underlyingMessage)\nRecorded command failure(s): \(failureSummary)"
        }
        return "Recorded command failure(s): \(failureSummary)"
    }
}
