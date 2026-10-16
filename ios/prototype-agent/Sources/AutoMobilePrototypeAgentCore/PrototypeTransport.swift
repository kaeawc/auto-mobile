import Foundation

/// The Network adapter supplies bytes and a sink; tests use exactly the same path without sockets.
struct PrototypeTransportConnection: Sendable {
    let chunks: AsyncThrowingStream<Data, Error>
    let send: @Sendable (Data) async -> Void
    let cancel: @Sendable () -> Void
}

/// Incoming JSONSerialization objects (without mutable-container options) and the agent's
/// replies/events contain immutable JSON leaves and value-type containers, never mutable Foundation
/// containers. Each enqueue hands its box once to its sole consumer. Copies retained by producers
/// cannot mutate shared JSON objects; only the consumer accesses the box's immutable dictionary.
private struct PrototypeTransportJSON: @unchecked Sendable {
    let object: [String: Any]
}

/// One FIFO writer for every outbound path. Authentication/removal are enqueued by the transport
/// actor; broadcasts/replies are enqueued synchronously by the main actor. Thus routing sees the
/// transport's auth state even when its main-actor count notification has not been consumed yet.
struct PrototypeTransportWriter: Sendable {
    private typealias Sink = @Sendable (Data) async -> Void
    private enum Operation: Sendable {
        case accepted(Int, Sink)
        case hello(Int, PrototypeTransportJSON)
        case frame(Int, PrototypeTransportJSON)
        case broadcast(PrototypeTransportJSON)
        case toHost(String, PrototypeTransportJSON)
        case hostFinished(String)
        case removed(Int)
        case flush(CheckedContinuation<Void, Never>)
    }

    private let continuation: AsyncStream<Operation>.Continuation

    /// `onHostRequestsLost` gets the host requests whose connection closed (or that had none).
    init(onHostRequestsLost: @escaping @Sendable ([String]) -> Void = { _ in }) {
        let output = AsyncStream<Operation>.makeStream()
        continuation = output.continuation
        Task.detached {
            var sinks: [Int: Sink] = [:]
            var routing = PrototypeHostRouting<Int>()
            for await operation in output.stream {
                switch operation {
                case let .accepted(id, sink): sinks[id] = sink
                case let .hello(id, json):
                    await Self.write(json, to: sinks[id])
                    routing.authenticate(id)
                case let .frame(id, json):
                    await Self.write(json, to: sinks[id])
                case let .broadcast(json):
                    if let data = Self.encode(json.object) {
                        for id in routing.all {
                            await sinks[id]?(data)
                        }
                    }
                case let .toHost(requestId, json):
                    // Exactly one connection: the most recently authenticated, remembered as owner.
                    if let id = routing.route(requestId) {
                        await Self.write(json, to: sinks[id])
                    } else {
                        onHostRequestsLost([requestId])
                    }
                case let .hostFinished(requestId): routing.finish(requestId)
                case let .removed(id):
                    let lost = routing.disconnect(id)
                    sinks[id] = nil
                    if !lost.isEmpty { onHostRequestsLost(lost) }
                case let .flush(done): done.resume()
                }
            }
        }
    }

    func accept(_ id: Int, connection: PrototypeTransportConnection) {
        continuation.yield(.accepted(id, connection.send))
    }

    func hello(_ message: [String: Any], on id: Int) {
        continuation.yield(.hello(id, PrototypeTransportJSON(object: message)))
    }

    func send(_ message: [String: Any], on id: Int) {
        continuation.yield(.frame(id, PrototypeTransportJSON(object: message)))
    }

    func broadcast(_ message: [String: Any]) {
        continuation.yield(.broadcast(PrototypeTransportJSON(object: message)))
    }

    /// A host request: written to the most recently authenticated connection only.
    func sendToHost(_ message: [String: Any], requestId: String) {
        continuation.yield(.toHost(requestId, PrototypeTransportJSON(object: message)))
    }

    /// The host request ended; its owner is forgotten.
    func hostRequestFinished(_ requestId: String) { continuation.yield(.hostFinished(requestId)) }

    func remove(_ id: Int) { continuation.yield(.removed(id)) }

    private static func write(_ json: PrototypeTransportJSON, to sink: Sink?) async {
        guard let data = encode(json.object) else { return }
        await sink?(data)
    }

    private static func encode(_ message: [String: Any]) -> Data? {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return nil }
        data.append(0x0A)
        return data
    }

    func flush() async {
        await withCheckedContinuation { continuation.yield(.flush($0)) }
    }

    func finish() { continuation.finish() }
}

/// Owns all framing/auth state on one executor. Every reader awaits this actor for each chunk;
/// all count changes and requests enter one FIFO stream consumed on the main actor.
actor PrototypeTransport {
    typealias Sleep = @Sendable (Double) async throws -> Void

    fileprivate enum Delivery: Sendable {
        case request(Int, PrototypeTransportJSON)
        case count(Int)
        case hostRequestsLost([String])
        case flush(CheckedContinuation<Void, Never>)
    }

    private struct Client {
        let connection: PrototypeTransportConnection
        var gate: PrototypeConnectionGate
        var framer = PrototypeLineFramer()
        let reader: Task<Void, Never>
        let deadline: Task<Void, Never>
    }

    private var clients: [Int: Client] = [:]
    private var tracker = PrototypeClientTracker<Int>()
    private var nextID = 0
    private var closed = false
    fileprivate let writer: PrototypeTransportWriter
    private let token: String
    private let capabilities: [String]
    private let maxAuthenticatedClients: Int?
    private let sleep: Sleep
    fileprivate let deliveries: AsyncStream<Delivery>
    private let delivery: AsyncStream<Delivery>.Continuation

    init(
        token: String,
        capabilities: [String] = PrototypeAgentProtocol.capabilities,
        maxAuthenticatedClients: Int? = nil,
        sleep: @escaping Sleep = { seconds in try await Task.sleep(for: .seconds(seconds)) }
    ) {
        self.token = token
        self.capabilities = capabilities
        self.maxAuthenticatedClients = maxAuthenticatedClients
        self.sleep = sleep
        let stream = AsyncStream<Delivery>.makeStream()
        deliveries = stream.stream
        delivery = stream.continuation
        let lost = stream.continuation
        writer = PrototypeTransportWriter { lost.yield(.hostRequestsLost($0)) }
    }

    @discardableResult
    func accept(_ connection: PrototypeTransportConnection) -> Int {
        nextID += 1
        let id = nextID
        guard !closed else {
            connection.cancel()
            return id
        }
        writer.accept(id, connection: connection)
        let reader = Task { [weak self] in
            do {
                for try await chunk in connection.chunks {
                    guard let self else { return }
                    await self.receive(chunk, on: id)
                }
            } catch {
                // As with a receive completion's error, buffered bytes were drained first.
            }
            await self?.disconnected(id)
        }
        let sleep = sleep
        let deadline = Task { [weak self] in
            do { try await sleep(PrototypeAgentProtocol.helloTimeoutSeconds) } catch { return }
            await self?.helloDeadline(id)
        }
        clients[id] = Client(
            connection: connection,
            gate: PrototypeConnectionGate(token: token, capabilities: capabilities),
            reader: reader,
            deadline: deadline
        )
        return id
    }

    /// Also useful for deterministic multi-connection tests: it is the readers' single ingress.
    func receive(_ data: Data, on id: Int) {
        guard var client = clients[id] else { return }
        client.framer.append(data)
        while client.gate.state != .closed {
            var action: PrototypeConnectionGate.Action
            switch client.framer.nextLine(limit: client.gate.frameLimit) {
            case .success(nil):
                clients[id] = client
                return
            case let .success(line?): action = client.gate.receive(line: line)
            case .failure: action = client.gate.fail(.frameTooLarge)
            }
            if case .helloAccepted = action,
               let maxAuthenticatedClients, tracker.count >= maxAuthenticatedClients
            {
                action = client.gate.fail(.hostBusy)
            }
            perform(action, on: id, connection: client.connection)
        }
        clients[id] = client
    }

    private func perform(
        _ action: PrototypeConnectionGate.Action,
        on id: Int,
        connection: PrototypeTransportConnection
    ) {
        switch action {
        case let .helloAccepted(object):
            writer.hello(object, on: id)
            if let count = tracker.authenticate(id) { delivery.yield(.count(count)) }
        case let .dispatch(object): delivery.yield(.request(id, PrototypeTransportJSON(object: object)))
        case let .rejectMalformed(object): writer.send(object, on: id)
        case let .close(reason):
            NSLog("[AutoMobilePrototypeAgent] closing connection: %@", String(describing: reason))
            connection.cancel()
        case .ignore: break
        }
    }

    /// Waits for previously produced deliveries and outbound calls, without waiting for any
    /// deferred reply. In-memory tests use this barrier instead of sleeps or scheduler polling.
    func flush() async {
        await withCheckedContinuation { delivery.yield(.flush($0)) }
    }

    /// Test-only synchronization: joins a finished input's reader before flushing deliveries and outbound calls.
    func waitForReader(_ id: Int) async {
        await clients[id]?.reader.value
    }

    func helloDeadline(_ id: Int) {
        guard var client = clients[id], client.gate.state == .awaitingHello else { return }
        perform(client.gate.fail(.helloTimeout), on: id, connection: client.connection)
        clients[id] = client
    }

    func disconnected(_ id: Int) {
        guard let client = clients.removeValue(forKey: id) else { return }
        client.connection.cancel()
        client.reader.cancel()
        client.deadline.cancel()
        writer.remove(id)
        if let count = tracker.close(id) { delivery.yield(.count(count)) }
    }

    func close() {
        closed = true
        for id in Array(clients.keys) {
            disconnected(id)
        }
    }

    deinit {
        writer.finish()
        delivery.finish()
    }
}

/// One consumer for every connection: a handler sees the client count produced before its request,
/// and returns immediately even when it retains the reply closure for a later display frame.
@MainActor
final class PrototypeTransportDelivery {
    typealias Reply = @MainActor ([String: Any]) -> Void
    typealias Handler = @MainActor ([String: Any], @escaping Reply) -> Void

    private let writer: PrototypeTransportWriter
    private let handler: Handler
    var onClientCountChanged: ((Int) -> Void)?
    /// Host requests whose connection closed, in order with the count changes.
    var onHostRequestsLost: (([String]) -> Void)?
    private var consumer: Task<Void, Never>?

    init(transport: PrototypeTransport, handler: @escaping Handler) {
        self.handler = handler
        writer = transport.writer
        consumer = Task { [weak self] in
            for await event in transport.deliveries {
                await self?.consume(event)
            }
        }
    }

    private func consume(_ event: PrototypeTransport.Delivery) async {
        switch event {
        case let .request(id, json):
            let writer = writer
            handler(json.object) { writer.send($0, on: id) }
        case let .count(count): onClientCountChanged?(count)
        case let .hostRequestsLost(ids): onHostRequestsLost?(ids)
        case let .flush(done):
            await writer.flush()
            done.resume()
        }
    }

    func broadcast(_ message: [String: Any]) { writer.broadcast(message) }

    /// Sends to the most recently authenticated connection only (host-proxied requests).
    func sendToHost(_ message: [String: Any], requestId: String) {
        writer.sendToHost(message, requestId: requestId)
    }

    func hostRequestFinished(_ requestId: String) { writer.hostRequestFinished(requestId) }

    deinit { consumer?.cancel() }
}
