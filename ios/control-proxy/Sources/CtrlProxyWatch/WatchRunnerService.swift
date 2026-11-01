import Foundation
import Network

/// A watch-only WebSocket endpoint. Network owns the HTTP upgrade, framing and ping/pong.
/// All callbacks and XCUITest operations run serially on the main queue.
@MainActor
final class WatchRunnerService {
    static let defaultPort: UInt16 = 8765
    private static let maxPendingRequests = 8

    private struct RequestEnvelope: Decodable {
        let requestId: String?
    }

    private let listener: NWListener
    private let handler: WatchCommandHandler
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var nextConnectionId = 0
    private var pendingRequests = 0
    private var didNotifyFailure = false
    private var isStopped = false

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
        listener.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self, !self.isStopped else { return }
                switch state {
                case .ready: onReady()
                case let .failed(error):
                    guard !self.didNotifyFailure else { return }
                    self.didNotifyFailure = true
                    onFailure(error)
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated {
                guard let self else {
                    connection.cancel()
                    return
                }
                self.accept(connection)
            }
        }
        listener.start(queue: .main)
    }

    func stop() {
        isStopped = true
        listener.cancel()
        let active = Array(connections.values)
        connections.removeAll()
        active.forEach { $0.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        guard !isStopped else {
            connection.cancel()
            return
        }
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        nextConnectionId += 1
        let id = nextConnectionId
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            MainActor.assumeIsolated {
                guard let self, let connection else { return }
                switch state {
                case .ready:
                    guard self.connections[key] != nil else {
                        connection.cancel()
                        return
                    }
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
                guard let self, self.connections[ObjectIdentifier(connection)] != nil else { return }
                if let error {
                    print("[CtrlProxyWatch] Receive failed: \(error)")
                    self.connections.removeValue(forKey: ObjectIdentifier(connection))
                    connection.cancel()
                    return
                }
                guard let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata, metadata.opcode != .close
                else {
                    self.connections.removeValue(forKey: ObjectIdentifier(connection))
                    connection.cancel()
                    return
                }
                if let data, metadata.opcode == .text || metadata.opcode == .binary {
                    if self.pendingRequests < Self.maxPendingRequests {
                        self.pendingRequests += 1
                        // Preserve receive order without running XCTest inside the receive callback.
                        DispatchQueue.main.async { [weak self] in
                            MainActor.assumeIsolated {
                                guard let self else { return }
                                defer { self.pendingRequests -= 1 }
                                let key = ObjectIdentifier(connection)
                                guard self.connections[key] != nil else { return }
                                let response = self.handler.handle(data)
                                guard self.connections[key] != nil else { return }
                                self.send(response, to: connection)
                            }
                        }
                    } else {
                        let requestId = (try? JSONDecoder().decode(RequestEnvelope.self, from: data))?.requestId
                        self.send(
                            WatchResponse(
                                type: "error", requestId: requestId, success: false,
                                error: "Too many pending requests", errorCode: nil
                            ), to: connection
                        )
                    }
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
