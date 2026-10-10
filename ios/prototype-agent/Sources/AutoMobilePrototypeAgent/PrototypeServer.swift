import Foundation
import Network

/// Loopback TCP server speaking newline-delimited JSON: requests in, `prototype_result` replies
/// and unsolicited `prototype_event` pushes out. The simulator shares the host's network stack,
/// so the host connects to 127.0.0.1 directly.
///
/// Every connection must authenticate first (#10566): its first frame is
/// `{type: "hello", token}` with the per-launch token, answered by `hello_result`. Until then it
/// gets no replies and no events, and anything else closes it.
final class PrototypeServer {
    typealias Handler = (_ message: [String: Any], _ reply: @escaping ([String: Any]) -> Void) -> Void

    /// One accepted connection and its auth/framing state. Touched only on `queue`.
    private final class Client {
        let connection: NWConnection
        var gate: PrototypeConnectionGate
        var framer = PrototypeLineFramer()
        /// Whether this connection currently counts toward `PrototypeServer.tracker`.
        var counted = false

        init(connection: NWConnection, token: String, capabilities: [String]) {
            self.connection = connection
            gate = PrototypeConnectionGate(token: token, capabilities: capabilities)
        }
    }

    private let configuration: PrototypeAgentConfiguration
    private let capabilities: [String]
    private let handler: Handler
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: Client] = [:]
    private var tracker = PrototypeClientTracker<ObjectIdentifier>()
    /// Reports the authenticated-connection count on the main queue each time it changes. Hops
    /// from the same serial queue as request dispatch, so a handler sees the count that was true
    /// when its request arrived.
    var onClientCountChanged: ((Int) -> Void)?
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.prototype-agent")

    init(configuration: PrototypeAgentConfiguration, capabilities: [String], handler: @escaping Handler) {
        self.configuration = configuration
        self.capabilities = capabilities
        self.handler = handler
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
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.stateUpdateHandler = { state in
                NSLog("[AutoMobilePrototypeAgent] listener %@", String(describing: state))
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            NSLog("[AutoMobilePrototypeAgent] listener failed: %@", String(describing: error))
        }
    }

    /// Events go only to authenticated connections.
    func broadcast(_ message: [String: Any]) {
        queue.async {
            self.clients.values
                .filter(\.gate.isAuthenticated)
                .forEach { self.send(message, on: $0.connection) }
        }
    }

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        let client = Client(connection: connection, token: configuration.token, capabilities: capabilities)
        clients[key] = client
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.remove(key)
            default: break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + PrototypeAgentProtocol.helloTimeoutSeconds) { [weak self, weak client] in
            guard let self, let client, client.gate.state == .awaitingHello else { return }
            self.perform(client.gate.fail(.helloTimeout), on: client)
        }
        receive(on: client)
    }

    private func remove(_ key: ObjectIdentifier) {
        guard let client = clients.removeValue(forKey: key) else { return }
        guard client.counted else { return }
        client.counted = false
        if let count = tracker.close(key) { publish(count) }
    }

    private func publish(_ count: Int) {
        DispatchQueue.main.async { self.onClientCountChanged?(count) }
    }

    private func receive(on client: Client) {
        client.connection
            .receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
                guard let self else { return }
                if let data { client.framer.append(data) }
                self.drain(client)
                if done || error != nil {
                    client.connection.cancel()
                } else if client.gate.state != .closed {
                    self.receive(on: client)
                }
            }
    }

    private func drain(_ client: Client) {
        while client.gate.state != .closed {
            switch client.framer.nextLine(limit: client.gate.frameLimit) {
            case .success(nil):
                return
            case let .success(line?):
                perform(client.gate.receive(line: line), on: client)
            case .failure:
                perform(client.gate.fail(.frameTooLarge), on: client)
            }
        }
    }

    private func perform(_ action: PrototypeConnectionGate.Action, on client: Client) {
        switch action {
        case let .helloAccepted(result):
            send(result, on: client.connection)
            let key = ObjectIdentifier(client.connection)
            if !client.counted, let count = tracker.authenticate(key) {
                client.counted = true
                publish(count)
            }
        case let .dispatch(message):
            dispatch(message, on: client.connection)
        case let .rejectMalformed(result):
            send(result, on: client.connection)
        case let .close(reason):
            NSLog("[AutoMobilePrototypeAgent] closing connection: %@", String(describing: reason))
            client.connection.cancel()
        case .ignore:
            break
        }
    }

    private func dispatch(_ message: [String: Any], on connection: NWConnection) {
        DispatchQueue.main.async {
            self.handler(message) { [weak self] reply in
                self?.queue.async { self?.send(reply, on: connection) }
            }
        }
    }

    private func send(_ message: [String: Any], on connection: NWConnection) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        connection.send(content: data, completion: .contentProcessed { _ in })
    }
}
