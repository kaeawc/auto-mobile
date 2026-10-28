import Foundation
import Network

enum SdkContractError: LocalizedError {
    case unknownScenario(String)
    case timedOut(seconds: UInt64)
    case listenerFailed(String)
    case unexpectedResponse(String)

    var errorDescription: String? {
        switch self {
        case let .unknownScenario(name):
            "Unknown SDK contract scenario: \(name)"
        case let .timedOut(seconds):
            "SDK contract scenario did not finish within \(seconds) s"
        case let .listenerFailed(reason):
            "Loopback listener failed: \(reason)"
        case let .unexpectedResponse(reason):
            "Loopback server returned an unexpected response: \(reason)"
        }
    }
}

/// Resumes a checked continuation at most once; Network.framework state handlers can report
/// several terminal states.
final class SdkContractResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    func run(_ body: () -> Void) {
        lock.lock()
        let first = !resumed
        resumed = true
        lock.unlock()
        if first {
            body()
        }
    }
}

/// HTTP and WebSocket listeners on the loopback interface, so contract scenarios never leave
/// the simulator. HTTP answers `GET /contract/<runId>/<case>` with `200 ok:<case>`; the
/// WebSocket listener echoes each text or binary message.
final class SdkContractLoopbackServer: @unchecked Sendable {
    struct Ports: Equatable, Sendable {
        let http: UInt16
        let webSocket: UInt16
    }

    static let maxRequestHeadBytes = 64 * 1024

    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.Playground.sdk-contract-server")
    private var listeners: [NWListener] = []
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    func start() async throws -> Ports {
        let http = try await ready(makeListener(webSocket: false))
        let webSocket = try await ready(makeListener(webSocket: true))
        return Ports(http: http, webSocket: webSocket)
    }

    func stop() {
        queue.async { [self] in
            listeners.forEach { $0.cancel() }
            listeners.removeAll()
            connections.values.forEach { $0.cancel() }
            connections.removeAll()
        }
    }

    private func makeListener(webSocket: Bool) throws -> NWListener {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.acceptLocalOnly = true
        if webSocket {
            let options = NWProtocolWebSocket.Options()
            options.autoReplyPing = true
            parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        }
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection, webSocket: webSocket)
        }
        return listener
    }

    private func ready(_ listener: NWListener) async throws -> UInt16 {
        queue.sync { listeners.append(listener) }
        return try await withCheckedThrowingContinuation { continuation in
            let once = SdkContractResumeOnce()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run {
                        if let port = listener.port?.rawValue {
                            continuation.resume(returning: port)
                        } else {
                            continuation.resume(throwing: SdkContractError.listenerFailed("ready without a port"))
                        }
                    }
                case let .failed(error):
                    once.run { continuation.resume(throwing: error) }
                case .cancelled:
                    once.run { continuation.resume(throwing: SdkContractError.listenerFailed("cancelled")) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    /// Runs on `queue`: listeners and connections deliver their handlers there.
    private func accept(_ connection: NWConnection, webSocket: Bool) {
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.connections[key] = nil
            default:
                break
            }
        }
        connection.start(queue: queue)
        if webSocket {
            receiveWebSocket(connection)
        } else {
            receiveHTTP(connection, buffered: Data())
        }
    }

    private func receiveHTTP(_ connection: NWConnection, buffered: Data) {
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 16 * 1024
        ) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var request = buffered
            if let data {
                request.append(data)
            }
            if let headerEnd = request.range(of: Data("\r\n\r\n".utf8)) {
                respondHTTP(connection, head: request[..<headerEnd.lowerBound])
            } else if error != nil || isComplete || request.count > Self.maxRequestHeadBytes {
                connection.cancel()
            } else {
                receiveHTTP(connection, buffered: request)
            }
        }
    }

    private func respondHTTP(_ connection: NWConnection, head: Data) {
        let requestLine = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
        let parts = requestLine.split(separator: " ")
        let path = parts.count >= 2 ? String(parts[1]) : "/"
        let caseName = path.split(separator: "/").last.map(String.init) ?? ""
        let isContractPath = parts.first == "GET" && path.hasPrefix("/contract/")
        let status = isContractPath ? "200 OK" : "404 Not Found"
        let body = Data((isContractPath ? "ok:\(caseName)" : "not found").utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/plain\r\nContent-Length: \(body.count)\r\n"
            + "Connection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func receiveWebSocket(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else {
                connection.cancel()
                return
            }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata
            guard let metadata, metadata.opcode != .close else {
                connection.cancel()
                return
            }
            if let data, metadata.opcode == .text || metadata.opcode == .binary {
                let reply = NWProtocolWebSocket.Metadata(opcode: metadata.opcode)
                let replyContext = NWConnection.ContentContext(identifier: "echo", metadata: [reply])
                connection.send(
                    content: data,
                    contentContext: replyContext,
                    isComplete: true,
                    completion: .contentProcessed { _ in }
                )
            }
            receiveWebSocket(connection)
        }
    }
}
