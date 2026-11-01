import Foundation
import Network

/// A watch-only WebSocket endpoint. Network owns the HTTP upgrade, framing and ping/pong.
/// All callbacks and XCUITest operations run serially on the main queue.
@MainActor
final class WatchRunnerService {
    static let defaultPort: UInt16 = 8765

    private let listener: NWListener
    private let handler: WatchCommandHandler
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var nextConnectionId = 0

    init(port: UInt16, handler: WatchCommandHandler) throws {
        self.handler = handler
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(integerLiteral: port))
        parameters.allowLocalEndpointReuse = true
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        webSocket.maximumMessageSize = 1024 * 1024
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        listener = try NWListener(using: parameters)
    }

    func start(
        onReady: @escaping @MainActor @Sendable () -> Void,
        onFailure: @escaping @MainActor @Sendable (Error) -> Void
    ) {
        listener.stateUpdateHandler = { state in
            MainActor.assumeIsolated {
                switch state {
                case .ready: onReady()
                case let .failed(error): onFailure(error)
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        listener.start(queue: .main)
    }

    func stop() {
        listener.cancel()
        let active = Array(connections.values)
        connections.removeAll()
        active.forEach { $0.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        nextConnectionId += 1
        let id = nextConnectionId
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            MainActor.assumeIsolated {
                guard let self, let connection else { return }
                switch state {
                case .ready:
                    self.send(WatchConnectedEvent(id: id), to: connection)
                    self.receive(connection)
                case .failed, .cancelled:
                    self.connections.removeValue(forKey: key)
                    connection.cancel()
                default: break
                }
            }
        }
        connection.start(queue: .main)
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let error {
                    print("[CtrlProxyWatch] Receive failed: \(error)")
                    connection.cancel()
                    return
                }
                guard let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata, metadata.opcode != .close
                else {
                    connection.cancel()
                    return
                }
                if let data, metadata.opcode == .text || metadata.opcode == .binary {
                    self.send(self.handler.handle(data), to: connection)
                }
                self.receive(connection)
            }
        }
    }

    private func send(_ value: some Encodable, to connection: NWConnection) {
        do {
            let data = try JSONEncoder().encode(value)
            let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "watch-response", metadata: [metadata])
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed {
                error in
                if let error {
                    print("[CtrlProxyWatch] Send failed: \(error)")
                    connection.cancel()
                }
            })
        } catch {
            print("[CtrlProxyWatch] Response encoding failed: \(error)")
            connection.cancel()
        }
    }
}
