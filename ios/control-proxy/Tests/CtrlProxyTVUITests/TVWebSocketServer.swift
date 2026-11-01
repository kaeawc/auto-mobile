import Foundation
import Network

// The unchanged shared connection constructs this envelope after its HTTP upgrade.
typealias ConnectedEvent = TVConnectedEvent

/// Minimal loopback listener; the existing connection owns HTTP upgrade and RFC 6455 framing.
final class TVWebSocketServer: @unchecked Sendable {
    private static let maxPendingRequests = 8
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.tv-server")
    private let connections = ConnectionRegistry<WebSocketConnection>()
    private let router: TVCommandRouter
    private let listener: NWListener
    private let port: UInt16
    // Accessed only on queue.
    private var nextId = 1
    private var pendingRequests = 0
    private var didNotifyFailure = false
    private var isStopped = false

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

    func start(onFailure: (@Sendable () -> Void)? = nil) {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case let .failed(error) = state {
                print("[CtrlProxyTV] Listener failed: \(error)")
                guard !didNotifyFailure else { return }
                didNotifyFailure = true
                onFailure?()
            }
        }
        listener.newConnectionHandler = { [weak self] socket in
            guard let self else { return }
            guard !isStopped else {
                socket.cancel()
                return
            }
            let id = nextId
            nextId += 1
            let connection = WebSocketConnection(
                id: id, connection: socket, queue: queue, boundPort: port,
                onMessage: { [weak self] data in
                    guard let self else { return }
                    guard pendingRequests < Self.maxPendingRequests else {
                        let response = WebSocketResponse.error(
                            type: "error", requestId: nil,
                            error: "Too many pending requests", errorCode: nil
                        )
                        if let reply = try? JSONEncoder().encode(response) {
                            connections.value(forId: id)?.send(reply)
                        }
                        return
                    }
                    pendingRequests += 1
                    // Enqueue directly on the main queue in receive order. A synchronous
                    // XCUITest press completes before the next hierarchy snapshot begins.
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        defer { queue.async { self.pendingRequests -= 1 } }
                        guard let connection = connections.value(forId: id) else { return }
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
        queue.sync {
            isStopped = true
            listener.cancel()
        }
        connections.removeAll().forEach { $0.close() }
    }
}
