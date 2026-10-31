import Foundation
import Network

// The unchanged shared connection constructs this envelope after its HTTP upgrade.
typealias ConnectedEvent = TVConnectedEvent

/// Minimal loopback listener; the existing connection owns HTTP upgrade and RFC 6455 framing.
final class TVWebSocketServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.tv-server")
    private let connections = ConnectionRegistry<WebSocketConnection>()
    private let router: TVCommandRouter
    private let listener: NWListener
    private let port: UInt16
    // Accessed only on queue.
    private var nextId = 1

    init(port: UInt16, router: TVCommandRouter) throws {
        self.port = port
        self.router = router
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(
            host: "127.0.0.1", port: NWEndpoint.Port(integerLiteral: port)
        )
        listener = try NWListener(using: parameters)
    }

    func start() {
        listener.stateUpdateHandler = { state in
            if case let .failed(error) = state {
                print("[CtrlProxyTV] Listener failed: \(error)")
            }
        }
        listener.newConnectionHandler = { [weak self] socket in
            guard let self else { return }
            let id = nextId
            nextId += 1
            let connection = WebSocketConnection(
                id: id, connection: socket, queue: queue, boundPort: port,
                onMessage: { [weak self] data in
                    guard let self else { return }
                    // Enqueue directly on the main queue in receive order. A synchronous
                    // XCUITest press completes before the next hierarchy snapshot begins.
                    DispatchQueue.main.async { [weak self] in
                        guard let self, let connection = connections.value(forId: id) else { return }
                        connection.send(router.handle(data))
                    }
                },
                onClose: { [weak self] in self?.connections.removeValue(forId: id) }
            )
            connections.set(connection, forId: id)
            connection.start()
        }
        listener.start(queue: queue)
    }

    func stop() {
        listener.cancel()
        connections.removeAll().forEach { $0.close() }
    }
}
