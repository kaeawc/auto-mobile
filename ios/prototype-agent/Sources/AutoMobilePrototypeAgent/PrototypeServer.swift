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
    private var listener: NWListener?
    private var acceptor: Task<Void, Never>?

    var onClientCountChanged: ((Int) -> Void)? {
        get { delivery.onClientCountChanged }
        set { delivery.onClientCountChanged = newValue }
    }

    init(configuration: PrototypeAgentConfiguration, capabilities: [String], handler: @escaping Handler) {
        self.configuration = configuration
        let transport = PrototypeTransport(token: configuration.token, capabilities: capabilities)
        self.transport = transport
        delivery = PrototypeTransportDelivery(transport: transport, handler: handler)
    }

    func start() {
        let parameters = NWParameters.tcp
        // Exclusive bind: endpoint reuse would let another local process listen on the same
        // port and receive the host's per-launch auth token.
        parameters.allowLocalEndpointReuse = false
        guard let endpointPort = NWEndpoint.Port(rawValue: configuration.port) else {
            NSLog("[AutoMobilePrototypeAgent] invalid port %d", configuration.port)
            return
        }
        // Loopback only: nothing off the host can reach the agent.
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpointPort)
        do {
            let listener = try NWListener(using: parameters)
            let incoming = AsyncStream<PrototypeTransportConnection>.makeStream()
            listener.newConnectionHandler = { connection in
                incoming.continuation.yield(Self.adapt(connection))
            }
            listener.stateUpdateHandler = { state in
                NSLog("[AutoMobilePrototypeAgent] listener %@", String(describing: state))
            }
            let transport = transport
            acceptor = Task.detached {
                for await connection in incoming.stream {
                    await transport.accept(connection)
                }
            }
            listener.start(queue: .global(qos: .userInitiated))
            self.listener = listener
        } catch {
            NSLog("[AutoMobilePrototypeAgent] listener failed: %@", String(describing: error))
        }
    }

    /// Events go only to authenticated connections, synchronously enqueued in call order.
    func broadcast(_ message: [String: Any]) { delivery.broadcast(message) }

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
