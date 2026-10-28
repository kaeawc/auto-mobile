import AutoMobileSDK
import Foundation
import Network

/// Phase A of the SDK contract suite (#5164): drives one exchange through each registered
/// network capture adapter (URLSession, URLSessionWebSocketTask, NWConnection) against the
/// loopback server and returns what it asked each adapter to record.
struct SdkContractNetworkScenario {
    static let authorizationValue = "Bearer contract-secret"

    let runId: String
    let ports: SdkContractLoopbackServer.Ports
    let recorder: NetworkCaptureRecorder

    func run() async throws -> [ExpectedNetworkEvent] {
        var expected = try await [urlSession()]
        try await expected.append(contentsOf: webSocket())
        try await expected.append(nwConnection())
        return expected
    }

    private func contractURL(scheme: String, port: UInt16, caseName: String) throws -> URL {
        guard let url = URL(string: "\(scheme)://127.0.0.1:\(port)/contract/\(runId)/\(caseName)") else {
            throw SdkContractError.unexpectedResponse("invalid contract URL for \(caseName)")
        }
        return url
    }

    private func urlSession() async throws -> ExpectedNetworkEvent {
        let caseName = "urlsession"
        let url = try contractURL(scheme: "http", port: ports.http, caseName: caseName)
        let connectionId = "contract-\(caseName)-\(runId)"
        var request = URLRequest(url: url)
        request.setValue(Self.authorizationValue, forHTTPHeaderField: "Authorization")
        request.setValue(runId, forHTTPHeaderField: "X-Contract-Run")
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }

        let adapter = URLSessionNetworkCaptureAdapter(recorder: recorder)
        let started = Date()
        let requestId = adapter.begin(
            url: url.absoluteString,
            method: "GET",
            connectionId: connectionId,
            requestHeaders: request.allHTTPHeaderFields
        )
        recorder.recordMetadata(requestId: requestId, key: "contract_case", value: caseName)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            adapter.didFail(requestId: requestId, error: error)
            throw error
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            adapter.didFail(requestId: requestId, error: SdkContractError.unexpectedResponse(caseName))
            throw SdkContractError.unexpectedResponse("\(caseName) did not return HTTP 200")
        }
        let body = String(decoding: data, as: UTF8.self)
        adapter.didReceiveResponseHeaders(requestId: requestId, headers: Self.stringHeaders(http))
        adapter.didReceiveBody(requestId: requestId, bytes: data.count, text: body)
        let durationMs = Date().timeIntervalSince(started) * 1000
        adapter.didReceiveMetrics(requestId: requestId, durationMs: durationMs)
        adapter.didComplete(requestId: requestId, statusCode: http.statusCode)
        return ExpectedNetworkEvent(
            caseName: caseName,
            url: url.absoluteString,
            method: "GET",
            protocolName: "http",
            direction: "response",
            requestId: requestId,
            connectionId: connectionId,
            statusCode: http.statusCode,
            requestBodySize: nil,
            responseBodySize: data.count,
            responseBody: body,
            metadata: ["contract_case": caseName, "duration_ms": String(durationMs)],
            redactedRequestHeaders: ["Authorization"]
        )
    }

    private func webSocket() async throws -> [ExpectedNetworkEvent] {
        let caseName = "websocket"
        let url = try contractURL(scheme: "ws", port: ports.webSocket, caseName: caseName)
        let connectionId = "contract-\(caseName)-\(runId)"
        let message = "contract:\(runId)"
        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: url)
        defer {
            task.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        }
        task.resume()

        let adapter = WebSocketNetworkCaptureAdapter(recorder: recorder)
        try await task.send(.string(message))
        adapter.recordFrame(
            url: url.absoluteString,
            connectionId: connectionId,
            direction: .sent,
            frameType: .text,
            payloadSize: message.utf8.count
        )
        guard case let .string(reply) = try await task.receive(), reply == message else {
            throw SdkContractError.unexpectedResponse("\(caseName) echo did not match")
        }
        adapter.recordFrame(
            url: url.absoluteString,
            connectionId: connectionId,
            direction: .received,
            frameType: .text,
            payloadSize: reply.utf8.count
        )
        return [
            frame(
                caseName: "\(caseName)-sent",
                url: url,
                connectionId: connectionId,
                direction: "sent",
                requestBodySize: message.utf8.count,
                responseBodySize: nil
            ),
            frame(
                caseName: "\(caseName)-received",
                url: url,
                connectionId: connectionId,
                direction: "received",
                requestBodySize: nil,
                responseBodySize: reply.utf8.count
            ),
        ]
    }

    private func frame(
        caseName: String,
        url: URL,
        connectionId: String,
        direction: String,
        requestBodySize: Int?,
        responseBodySize: Int?
    )
        -> ExpectedNetworkEvent
    {
        ExpectedNetworkEvent(
            caseName: caseName,
            url: url.absoluteString,
            method: "text",
            protocolName: "websocket",
            direction: direction,
            requestId: nil,
            connectionId: connectionId,
            statusCode: nil,
            requestBodySize: requestBodySize,
            responseBodySize: responseBodySize,
            responseBody: nil,
            metadata: nil,
            redactedRequestHeaders: nil
        )
    }

    private func nwConnection() async throws -> ExpectedNetworkEvent {
        let caseName = "nwconnection"
        let endpoint = try contractURL(scheme: "tcp", port: ports.http, caseName: caseName).absoluteString
        let connectionId = "contract-\(caseName)-\(runId)"
        guard let port = NWEndpoint.Port(rawValue: ports.http) else {
            throw SdkContractError.listenerFailed("invalid HTTP port \(ports.http)")
        }
        let adapter = NWConnectionNetworkCaptureAdapter(recorder: recorder)
        let requestId = adapter.begin(endpoint: endpoint, connectionId: connectionId)
        recorder.recordMetadata(requestId: requestId, key: "contract_case", value: caseName)

        let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        let queue = DispatchQueue(label: "dev.jasonpearson.automobile.Playground.sdk-contract-nwconnection")
        defer { connection.cancel() }
        let requestHead = "GET /contract/\(runId)/\(caseName) HTTP/1.1\r\n"
            + "Host: 127.0.0.1\r\nConnection: close\r\n\r\n"
        let payload = Data(requestHead.utf8)
        let received: Data
        do {
            try await Self.waitUntilReady(connection, queue: queue)
            adapter.didUpdateState(requestId: requestId, state: "ready")
            try await Self.send(payload, on: connection)
            adapter.didSend(requestId: requestId, bytes: payload.count)
            received = try await Self.receiveUntilClosed(connection)
        } catch let error as NWError {
            adapter.didFail(requestId: requestId, error: error)
            throw error
        } catch {
            adapter.didCancel(requestId: requestId)
            throw error
        }
        guard String(decoding: received, as: UTF8.self).hasPrefix("HTTP/1.1 200") else {
            adapter.didCancel(requestId: requestId)
            throw SdkContractError.unexpectedResponse("\(caseName) did not return HTTP 200")
        }
        adapter.didReceive(requestId: requestId, bytes: received.count)
        adapter.didComplete(requestId: requestId)
        return ExpectedNetworkEvent(
            caseName: caseName,
            url: endpoint,
            method: "CONNECTION",
            protocolName: "nwconnection",
            direction: "response",
            requestId: requestId,
            connectionId: connectionId,
            statusCode: nil,
            requestBodySize: payload.count,
            responseBodySize: received.count,
            responseBody: nil,
            metadata: ["contract_case": caseName, "connection_state": "ready"],
            redactedRequestHeaders: nil
        )
    }

    private static func stringHeaders(_ response: HTTPURLResponse) -> [String: String] {
        response.allHeaderFields.reduce(into: [String: String]()) { headers, field in
            if let name = field.key as? String {
                headers[name] = "\(field.value)"
            }
        }
    }

    private static func waitUntilReady(_ connection: NWConnection, queue: DispatchQueue) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = SdkContractResumeOnce()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run { continuation.resume() }
                case let .waiting(error), let .failed(error):
                    // Loopback never needs to wait for a path; waiting means nothing is listening.
                    once.run { continuation.resume(throwing: error) }
                case .cancelled:
                    once.run { continuation.resume(throwing: SdkContractError.listenerFailed("connection cancelled")) }
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    private static func send(_ data: Data, on connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private static func receiveUntilClosed(_ connection: NWConnection) async throws -> Data {
        var received = Data()
        while true {
            let (chunk, isComplete) = try await receiveChunk(connection)
            received.append(chunk)
            if isComplete {
                return received
            }
        }
    }

    private static func receiveChunk(_ connection: NWConnection) async throws -> (Data, Bool) {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { data, _, isComplete, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (data ?? Data(), isComplete || data == nil))
                }
            }
        }
    }
}
