import AutoMobileSdkWire
import Foundation
import Network

enum SdkContractError: LocalizedError {
    case unknownScenario(String)
    case timedOut(seconds: UInt64)
    case listenerFailed(String)
    case unexpectedResponse(String)
    case caseFailed(name: String, underlying: String)
    case rulesNotInstalled(seconds: Double)
    case harnessNotFinished(seconds: Double)

    /// Names the case and keeps the error domain and code, which a localized message loses.
    static func describe(_ error: Error) -> String {
        if let contractError = error as? SdkContractError {
            return contractError.errorDescription ?? String(describing: contractError)
        }
        let nsError = error as NSError
        return "\(nsError.localizedDescription) [\(nsError.domain) \(nsError.code)]"
    }

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
        case let .caseFailed(name, underlying):
            "Case \(name) failed: \(underlying)"
        case let .harnessNotFinished(seconds):
            "The harness did not finish the observation cases within \(Int(seconds)) s"
        case let .rulesNotInstalled(seconds):
            "The harness did not install the fault rules within \(Int(seconds)) s"
        }
    }
}

/// HTTP and WebSocket listeners on the loopback interface, so contract scenarios never leave
/// the simulator. HTTP answers `GET /contract/<runId>/<case>` with `200 ok:<case>`; the
/// WebSocket listener echoes each text or binary message. Connection handlers hold the server
/// strongly so a request is never dropped silently; `stop()` cancels every connection, which
/// releases them.
final class SdkContractLoopbackServer: @unchecked Sendable {
    struct Ports: Equatable, Sendable {
        let http: UInt16
        let webSocket: UInt16
    }

    static let maxRequestHeadBytes = 64 * 1024
    static let maxEvents = 64

    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.Playground.sdk-contract-server")
    private var listeners: [NWListener] = []
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    /// What the server saw, so a failed run says where an exchange stopped.
    private var events: [String] = []

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

    func eventLog() -> [String] {
        queue.sync { events }
    }

    /// Runs on `queue`.
    private func record(_ event: String) {
        if events.count < Self.maxEvents {
            events.append(event)
        }
    }

    private func makeListener(webSocket: Bool) throws -> NWListener {
        let parameters = NWParameters.tcp
        // Loopback only; `acceptLocalOnly` is not set because loopback peers need not count
        // as "local network" peers.
        parameters.requiredInterfaceType = .loopback
        if webSocket {
            let options = NWProtocolWebSocket.Options()
            options.autoReplyPing = true
            parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        }
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [self] connection in
            accept(connection, webSocket: webSocket)
        }
        return listener
    }

    private func ready(_ listener: NWListener) async throws -> UInt16 {
        queue.sync { listeners.append(listener) }
        return try await withCancellableCheckedContinuation { continuation in
            listener.stateUpdateHandler = { [self] state in
                switch state {
                case .ready:
                    if let port = listener.port?.rawValue {
                        record("listening \(port)")
                        continuation.resume(returning: port)
                    } else {
                        continuation.resume(throwing: SdkContractError.listenerFailed("ready without a port"))
                    }
                case let .failed(error):
                    record("listener failed \(error)")
                    continuation.resume(throwing: error)
                case .cancelled:
                    continuation.resume(throwing: SdkContractError.listenerFailed("cancelled"))
                default:
                    break
                }
            }
            listener.start(queue: queue)
        } onCancel: {
            listener.cancel()
        }
    }

    /// Runs on `queue`: listeners and connections deliver their handlers there.
    private func accept(_ connection: NWConnection, webSocket: Bool) {
        let key = ObjectIdentifier(connection)
        let kind = webSocket ? "ws" : "http"
        connections[key] = connection
        record("\(kind) accepted")
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case let .failed(error):
                record("\(kind) failed \(error)")
                connections[key] = nil
            case .cancelled:
                connections[key] = nil
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
        ) { [self] data, _, isComplete, error in
            var request = buffered
            if let data {
                request.append(data)
            }
            if let headerEnd = request.range(of: Data("\r\n\r\n".utf8)) {
                respondHTTP(connection, head: request[..<headerEnd.lowerBound])
            } else if error != nil || isComplete || request.count > Self.maxRequestHeadBytes {
                let reason = error.map { "\($0)" } ?? (isComplete ? "peer closed" : "head too large")
                record("http closed before request head (\(request.count) bytes): \(reason)")
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
        record("http request \(parts.first ?? "?") \(path) -> \(status)")
        let body = Data((isContractPath ? "ok:\(caseName)" : "not found").utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/plain\r\nContent-Length: \(body.count)\r\n"
            + "Connection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(body)
        // Send as the final message (a graceful write close), then wait for the client to
        // close before cancelling, so the client never sees a reset mid-read.
        connection.send(
            content: response,
            contentContext: .finalMessage,
            isComplete: true,
            completion: .contentProcessed { [self] error in
                record("http response sent\(error.map { " error \($0)" } ?? "")")
                cancelWhenPeerCloses(connection)
            }
        )
    }

    private func cancelWhenPeerCloses(_ connection: NWConnection) {
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 16 * 1024
        ) { [self] _, _, isComplete, error in
            if isComplete || error != nil {
                connection.cancel()
            } else {
                cancelWhenPeerCloses(connection)
            }
        }
    }

    private func receiveWebSocket(_ connection: NWConnection) {
        connection.receiveMessage { [self] data, context, _, error in
            if let error {
                record("ws receive failed \(error)")
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
                record("ws echo \(data.count) bytes")
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
