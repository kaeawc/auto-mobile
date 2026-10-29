import AutoMobileSDK
import Foundation
import Network

/// Network slice of the SDK contract suite (#5164): registers each transport with the host
/// registration API (URLSession, URLSessionWebSocketTask, NWConnection), drives one exchange
/// through each against the loopback server and returns what the SDK must record.
struct SdkContractNetworkScenario {
    static let authorizationValue = "Bearer contract-secret"

    let runId: String
    let ports: SdkContractLoopbackServer.Ports

    func run() async throws -> [ExpectedNetworkEvent] {
        var expected = try await [named("urlsession", urlSession)]
        try await expected.append(contentsOf: named("websocket", webSocket))
        try await expected.append(named("nwconnection", nwConnection))
        return expected
    }

    /// Reports which case failed, with the error domain and code.
    private func named<T>(_ name: String, _ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch {
            throw SdkContractError.caseFailed(name: name, underlying: SdkContractError.describe(error))
        }
    }

    private func contractURL(scheme: String, port: UInt16, caseName: String) throws -> URL {
        guard let url = URL(string: "\(scheme)://127.0.0.1:\(port)/contract/\(runId)/\(caseName)") else {
            throw SdkContractError.unexpectedResponse("invalid contract URL for \(caseName)")
        }
        return url
    }

    /// A registered default configuration is captured by the SDK's `URLProtocol`, which records
    /// the exchange without a request id, connection id, protocol name or direction.
    private func urlSession() async throws -> ExpectedNetworkEvent {
        let caseName = "urlsession"
        let url = try contractURL(scheme: "http", port: ports.http, caseName: caseName)
        var request = URLRequest(url: url)
        request.setValue(Self.authorizationValue, forHTTPHeaderField: "Authorization")
        request.setValue(runId, forHTTPHeaderField: "X-Contract-Run")
        let configuration = URLSessionConfiguration.ephemeral
        AutoMobileNetwork.shared.registerURLSession(configuration)
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SdkContractError.unexpectedResponse("\(caseName) did not return HTTP 200")
        }
        return ExpectedNetworkEvent(
            caseName: caseName,
            url: url.absoluteString,
            method: "GET",
            protocolName: nil,
            direction: nil,
            requestId: nil,
            connectionId: nil,
            statusCode: http.statusCode,
            requestBodySize: nil,
            responseBodySize: data.count,
            responseBody: String(decoding: data, as: UTF8.self),
            metadata: nil,
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

        let adapter = AutoMobileNetwork.shared.registerWebSocket()
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
        let adapter = AutoMobileNetwork.shared.registerNWConnection()
        let requestId = adapter.begin(endpoint: endpoint, connectionId: connectionId)

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
            metadata: ["connection_state": "ready"],
            redactedRequestHeaders: nil
        )
    }

    static func waitUntilReady(_ connection: NWConnection, queue: DispatchQueue) async throws {
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

    static func send(_ data: Data, on connection: NWConnection) async throws {
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

    static func receiveUntilClosed(_ connection: NWConnection) async throws -> Data {
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

/// Capability slice (#5164 phase C): the transport capability matrix in a fresh process, before
/// and after the host registers a default URLSession, a WebSocket and an NWConnection. The
/// background URLSession family is left unregistered on purpose.
enum SdkContractCapabilityScenario {
    static func run(network: AutoMobileNetwork = .shared) -> CapabilityObservation {
        let before = network.transportCapabilities()
        network.registerURLSession(URLSessionConfiguration.ephemeral)
        _ = network.registerWebSocket()
        _ = network.registerNWConnection()
        return CapabilityObservation(beforeRegistration: before, afterRegistration: network.transportCapabilities())
    }
}

/// Fault slice (#5163): runs one exchange per case through the transports the host registration
/// API returns, after the harness installed delay and fail rules through CtrlProxy, and reports
/// what the client saw. Case names match `FAULT_CASES` in `scripts/ios/sdk-contract/faultSlice.ts`.
struct SdkContractFaultScenario {
    static let urlSessionCases = ["fault-urlsession-delay", "fault-urlsession-fail", "fault-urlsession-fail-expired"]
    static let webSocketCases = ["fault-websocket-delay", "fault-websocket-fail"]
    static let nwConnectionCases = ["fault-nwconnection-delay", "fault-nwconnection-fail"]

    let runId: String
    let ports: SdkContractLoopbackServer.Ports

    func run() async throws -> [FaultCaseObservation] {
        let configuration = URLSessionConfiguration.ephemeral
        AutoMobileNetwork.shared.registerURLSession(configuration)
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        var observations: [FaultCaseObservation] = []
        // In order: the expired case must follow the fail case that consumes its one-shot rule.
        for caseName in Self.urlSessionCases {
            try await observations.append(urlSessionCase(caseName, session: session))
        }
        for caseName in Self.webSocketCases {
            try await observations.append(webSocketCase(caseName))
        }
        for caseName in Self.nwConnectionCases {
            try await observations.append(nwConnectionCase(caseName))
        }
        return observations
    }

    private func contractURL(scheme: String, port: UInt16, caseName: String) throws -> URL {
        guard let url = URL(string: "\(scheme)://127.0.0.1:\(port)/contract/\(runId)/\(caseName)") else {
            throw SdkContractError.unexpectedResponse("invalid contract URL for \(caseName)")
        }
        return url
    }

    private func urlSessionCase(_ caseName: String, session: URLSession) async throws -> FaultCaseObservation {
        let url = try contractURL(scheme: "http", port: ports.http, caseName: caseName)
        let started = Date()
        var clientError: String?
        do {
            let (_, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                clientError = "http:\(http.statusCode)"
            }
        } catch {
            clientError = Self.errorCode(error)
        }
        return FaultCaseObservation(
            caseName: caseName, url: url.absoluteString, connectionId: nil, requestId: nil,
            elapsedMs: Self.elapsedMs(since: started), clientError: clientError
        )
    }

    private func webSocketCase(_ caseName: String) async throws -> FaultCaseObservation {
        let url = try contractURL(scheme: "ws", port: ports.webSocket, caseName: caseName)
        let connectionId = "contract-\(caseName)-\(runId)"
        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: url)
        defer {
            task.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        }
        task.resume()

        let adapter = AutoMobileNetwork.shared.registerWebSocket()
        let message = URLSessionWebSocketTask.Message.string("contract:\(runId)")
        let started = Date()
        var clientError: String?
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                adapter.send(message, on: task, connectionId: connectionId) { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            }
        } catch {
            clientError = Self.errorCode(error)
        }
        return FaultCaseObservation(
            caseName: caseName, url: url.absoluteString, connectionId: connectionId, requestId: nil,
            elapsedMs: Self.elapsedMs(since: started), clientError: clientError
        )
    }

    private func nwConnectionCase(_ caseName: String) async throws -> FaultCaseObservation {
        let endpoint = try contractURL(scheme: "tcp", port: ports.http, caseName: caseName).absoluteString
        let connectionId = "contract-\(caseName)-\(runId)"
        guard let port = NWEndpoint.Port(rawValue: ports.http) else {
            throw SdkContractError.listenerFailed("invalid HTTP port \(ports.http)")
        }
        let adapter = AutoMobileNetwork.shared.registerNWConnection()
        let requestId = adapter.begin(endpoint: endpoint, connectionId: connectionId)
        let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        let queue = DispatchQueue(label: "dev.jasonpearson.automobile.Playground.sdk-contract-fault-nwconnection")
        defer { connection.cancel() }

        let started = Date()
        var clientError: String?
        do {
            try await Self.start(
                connection, through: adapter, queue: queue,
                endpoint: endpoint, connectionId: connectionId, requestId: requestId
            )
            adapter.didUpdateState(requestId: requestId, state: "ready")
            let payload = Data(
                "GET /contract/\(runId)/\(caseName) HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".utf8
            )
            try await SdkContractNetworkScenario.send(payload, on: connection)
            adapter.didSend(requestId: requestId, bytes: payload.count)
            let received = try await SdkContractNetworkScenario.receiveUntilClosed(connection)
            adapter.didReceive(requestId: requestId, bytes: received.count)
            adapter.didComplete(requestId: requestId)
        } catch {
            clientError = Self.errorCode(error)
            // A no-op when a fail rule already recorded the failed exchange.
            adapter.didCancel(requestId: requestId)
        }
        return FaultCaseObservation(
            caseName: caseName, url: endpoint, connectionId: connectionId, requestId: requestId,
            elapsedMs: Self.elapsedMs(since: started), clientError: clientError
        )
    }

    /// Starts the connection through the adapter, which applies a matched rule first. A fail
    /// rule cancels the connection and reports the POSIX error through `onFault`, so the
    /// `cancelled` state is left for that callback to resolve.
    private static func start(
        _ connection: NWConnection,
        through adapter: NWConnectionNetworkCaptureAdapter,
        queue: DispatchQueue,
        endpoint: String,
        connectionId: String,
        requestId: String
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = SdkContractResumeOnce()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run { continuation.resume() }
                case let .waiting(error), let .failed(error):
                    once.run { continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            adapter.start(
                connection, queue: queue, endpoint: endpoint,
                connectionId: connectionId, requestId: requestId
            ) { error in
                once.run { continuation.resume(throwing: error) }
            }
        }
    }

    static func errorCode(_ error: Error) -> String {
        if let nwError = error as? NWError, case let .posix(code) = nwError {
            return "posix:\(code.rawValue)"
        }
        let nsError = error as NSError
        return "\(nsError.domain):\(nsError.code)"
    }

    private static func elapsedMs(since started: Date) -> Double {
        Date().timeIntervalSince(started) * 1000
    }
}
