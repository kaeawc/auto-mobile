import Foundation
import Network

/// Loopback TCP adapter for the device-free ordered transport. Network callbacks only feed streams;
/// the transport actor owns framing/auth and one main-actor consumer owns handler delivery.
@MainActor
final class PrototypeServer {
    typealias Handler = PrototypeTransportDelivery.Handler

    private let configuration: PrototypeAgentConfiguration
    private let transport: PrototypeTransport
    private let delivery: PrototypeTransportDelivery
    private let onReady: ((UInt16) -> Void)?
    private let listenerQueue = DispatchQueue(label: "dev.jasonpearson.automobile.prototype-agent.listener")
    private var listener: NWListener?
    private var acceptor: Task<Void, Never>?
    private var incomingConnections: AsyncStream<PrototypeTransportConnection>.Continuation?
    var onFailed: (() -> Void)?

    var onClientCountChanged: ((Int) -> Void)? {
        get { delivery.onClientCountChanged }
        set { delivery.onClientCountChanged = newValue }
    }

    init(
        configuration: PrototypeAgentConfiguration,
        capabilities: [String],
        maxAuthenticatedClients: Int? = nil,
        onReady: ((UInt16) -> Void)? = nil,
        handler: @escaping Handler
    ) {
        self.configuration = configuration
        self.onReady = onReady
        let transport = PrototypeTransport(
            token: configuration.token, capabilities: capabilities, maxAuthenticatedClients: maxAuthenticatedClients
        )
        self.transport = transport
        delivery = PrototypeTransportDelivery(transport: transport, handler: handler)
    }

    func start() {
        let parameters = NWParameters.tcp
        // Exclusive bind: endpoint reuse would let another local process listen on the same
        // port and receive the host's per-launch auth token.
        parameters.allowLocalEndpointReuse = false
        guard let endpointPort = configuration.port == 0 ? NWEndpoint.Port.any : NWEndpoint
            .Port(rawValue: configuration.port)
        else {
            NSLog("[AutoMobilePrototypeAgent] invalid port %d", configuration.port)
            return
        }
        // Loopback only: nothing off the host can reach the agent.
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpointPort)
        do {
            let listener = try NWListener(using: parameters)
            let incoming = AsyncStream<PrototypeTransportConnection>.makeStream()
            incomingConnections = incoming.continuation
            listener.newConnectionHandler = { connection in
                let adapted = Self.adapt(connection)
                if case .terminated = incoming.continuation.yield(adapted) { adapted.cancel() }
            }
            let hostedViewer = configuration.port == 0
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                if !hostedViewer {
                    NSLog("[AutoMobilePrototypeAgent] listener %@", String(describing: state))
                }
                if case .ready = state, let listener, let port = listener.port?.rawValue {
                    Task { @MainActor [weak self] in
                        guard let self, self.listener === listener else { return }
                        self.onReady?(port)
                    }
                }
                switch state {
                case .failed, .cancelled:
                    incoming.continuation.finish()
                    Task { @MainActor [weak self] in self?.onFailed?() }
                default: break
                }
            }
            let transport = transport
            acceptor = Task.detached {
                for await connection in incoming.stream {
                    await transport.accept(connection)
                }
            }
            self.listener = listener
            listener.start(queue: listenerQueue)
        } catch {
            if configuration.port == 0 {
                NSLog("[AutoMobilePrototypeAgent] viewer listener failed (error code %ld)", (error as NSError).code)
            } else {
                NSLog("[AutoMobilePrototypeAgent] listener failed: %@", String(describing: error))
            }
        }
    }

    func close() {
        listener?.cancel()
        listener = nil
        incomingConnections?.finish()
        incomingConnections = nil
        // Drain already-adapted connections into the closed transport so every socket is
        // cancelled. Cancelling the consumer here would abandon its buffered sockets.
        acceptor = nil
        let transport = transport
        Task { await transport.close() }
    }

    /// Events go only to authenticated connections, synchronously enqueued in call order.
    func broadcast(_ message: [String: Any]) { delivery.broadcast(message) }

    /// A host-proxied request goes to the most recently authenticated connection only, so a
    /// side-effecting call is never run by two hosts.
    func sendToHost(_ message: [String: Any]) { delivery.sendToHost(message) }

    /// Network.framework requires a dispatch queue for callbacks; it owns no transport state.
    private nonisolated static func adapt(_ connection: NWConnection) -> PrototypeTransportConnection {
        let input = AsyncThrowingStream<Data, Error>.makeStream()
        connection.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled: input.continuation.finish()
            default: break
            }
        }
        // Preserve callback order so a terminal state cannot finish the stream before the final
        // receive completion yields its bytes. Only this adapter runs on the Network callback queue.
        connection.start(queue: DispatchQueue(label: "dev.jasonpearson.automobile.prototype-agent"))
        receive(connection, into: input.continuation)
        return PrototypeTransportConnection(chunks: input.stream, send: { data in
            connection.send(content: data, completion: .contentProcessed { _ in })
        }, cancel: { connection.cancel() })
    }

    private nonisolated static func receive(
        _ connection: NWConnection,
        into input: AsyncThrowingStream<Data, Error>.Continuation
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, error in
            if let data { input.yield(data) }
            if done || error != nil {
                if let error { input.finish(throwing: error) } else { input.finish() }
                connection.cancel()
            } else {
                receive(connection, into: input)
            }
        }
    }
}
