import Foundation
import Network

/// Loopback TCP server speaking newline-delimited JSON: requests in, `overlay_result` replies
/// and unsolicited `overlay_event` pushes out. The simulator shares the host's network stack,
/// so the host connects to 127.0.0.1 directly.
final class OverlayServer {
    typealias Handler = (_ message: [String: Any], _ reply: @escaping ([String: Any]) -> Void) -> Void

    private let port: UInt16
    private let handler: Handler
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.overlay-agent")

    init(port: UInt16, handler: @escaping Handler) {
        self.port = port
        self.handler = handler
    }

    func start() {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            NSLog("[AutoMobileOverlayAgent] invalid port %d", port)
            return
        }
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpointPort)
        do {
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.stateUpdateHandler = { state in
                NSLog("[AutoMobileOverlayAgent] listener %@", String(describing: state))
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            NSLog("[AutoMobileOverlayAgent] listener failed: %@", String(describing: error))
        }
    }

    func broadcast(_ message: [String: Any]) {
        queue.async {
            self.connections.values.forEach { self.send(message, on: $0) }
        }
    }

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.connections[key] = nil
            default: break
            }
        }
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self else { return }
            var pending = buffer
            if let data { pending.append(data) }
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = pending[pending.startIndex ..< newline]
                pending = Data(pending[pending.index(after: newline)...])
                self.dispatch(line, on: connection)
            }
            if done || error != nil {
                connection.cancel()
            } else {
                self.receive(on: connection, buffer: pending)
            }
        }
    }

    private func dispatch(_ line: Data, on connection: NWConnection) {
        guard !line.isEmpty else { return }
        guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
            send(["type": "overlay_result", "success": false, "error": "Request is not a JSON object"], on: connection)
            return
        }
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
