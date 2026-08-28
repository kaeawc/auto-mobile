#if DEBUG && !os(watchOS)
import Foundation
import Network

/// The hierarchy operations served by `SdkHierarchyServer`. Keeping this narrow
/// lets the server's listener lifecycle compile and be tested on macOS, where
/// `ViewHierarchyTracker` itself is unavailable because it needs UIKit.
protocol SdkHierarchyServing: AnyObject {
    func getLatestHierarchy() -> SdkViewHierarchy?
    func walkNow() -> SdkViewHierarchy
    var bundleId: String? { get }
}

/// The subset of `NWListener` operations `SdkHierarchyServer` drives. This
/// seam keeps the server lifecycle testable without binding port 8766.
protocol SdkHierarchyListener: AnyObject {
    var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)? { get set }
    var newConnectionHandler: (@Sendable (NWConnection) -> Void)? { get set }
    func start(queue: DispatchQueue)
    func cancel()
}

extension NWListener: SdkHierarchyListener {}

/// Minimal HTTP server running inside the target app on port 8766.
/// Serves view hierarchy snapshots to control-proxy on demand.
///
/// Endpoints:
/// - `GET /health` -> `{"status":"ok","bundleId":"<sdk app bundle id>"}`
/// - `GET /hierarchy` -> latest cached hierarchy (fast, no main-thread work)
/// - `GET /hierarchy/fresh` -> synchronous main-thread walk (slower but guaranteed fresh)
/// - `POST /highlight` -> render a debug highlight in the app-under-test process
final class SdkHierarchyServer: @unchecked Sendable {

    static let port: UInt16 = 8766
    private static let httpHeaderDelimiter = Data("\r\n\r\n".utf8)
    private static let maxHttpBodyBytes = 1024 * 1024

    private let lock: any NSLocking
    private var listener: (any SdkHierarchyListener)?
    private let listenerFactory: () throws -> any SdkHierarchyListener
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.sdk.hierarchy-server")
    private weak var tracker: (any SdkHierarchyServing)?
    private let databaseRouteHandler = SdkDatabaseRouteHandler()

    init(
        tracker: any SdkHierarchyServing,
        listenerFactory: @escaping () throws -> any SdkHierarchyListener = SdkHierarchyServer.makeListener,
        lifecycleLock: any NSLocking = NSLock()
    ) {
        self.tracker = tracker
        self.listenerFactory = listenerFactory
        lock = lifecycleLock
    }

    // MARK: - Lifecycle

    func start() {
        // Hold the lock across the entire start — assign, configure, and `start()` —
        // so a concurrent `stop()` cannot interleave between the `listener` assignment
        // and `nwListener.start()`, which would cancel the listener yet leave it
        // started (and `listener == nil`, so a later `start()` re-binds port 8766). The
        // handlers only fire asynchronously on `queue`, never synchronously here, so
        // there is no re-entrancy while the lock is held.
        lock.lock()
        defer { lock.unlock() }
        guard listener == nil else { return }

        do {
            let nwListener = try listenerFactory()
            listener = nwListener

            nwListener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    InternalLogger.debug("[SdkHierarchyServer] Ready on port \(Self.port)")
                case let .failed(error):
                    InternalLogger.debug("[SdkHierarchyServer] Failed: \(error)")
                default:
                    break
                }
            }

            nwListener.newConnectionHandler = { [weak self] connection in
                self?.handleConnection(connection)
            }

            nwListener.start(queue: queue)
        } catch {
            InternalLogger.debug("[SdkHierarchyServer] Failed to create listener: \(error)")
        }
    }

    func stop() {
        lock.lock()
        let listenerToCancel = listener
        listener = nil
        lock.unlock()
        listenerToCancel?.cancel()
    }

    private static func makeListener() throws -> any SdkHierarchyListener {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        return try NWListener(using: parameters, on: NWEndpoint.Port(integerLiteral: port))
    }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            guard let self = self else {
                connection.cancel()
                return
            }

            if error != nil {
                connection.cancel()
                return
            }

            guard let data = data else {
                connection.cancel()
                return
            }

            self.readCompleteHttpHeaders(connection, initialData: data) { [weak self] requestData in
                guard let self = self else {
                    connection.cancel()
                    return
                }
                guard let requestData = requestData,
                      let headerData = Self.httpHeaderData(from: requestData),
                      let request = String(data: headerData, encoding: .utf8) else {
                    connection.cancel()
                    return
                }

                if request.contains("GET /hierarchy/fresh") {
                    self.handleFreshHierarchy(connection)
                } else if request.contains("GET /hierarchy") {
                    self.handleCachedHierarchy(connection)
                } else if request.contains("GET /health") {
                    self.handleHealth(connection)
                } else if request.contains("POST /network/mock") {
                    self.handleNetworkMock(connection, initialData: requestData)
                } else if request.contains("POST /network/error-simulation") {
                    self.handleNetworkErrorSimulation(connection, initialData: requestData)
                } else if request.contains("POST /network/fault-rules") {
                    self.handleNetworkFaultRules(connection, initialData: requestData)
                } else if request.contains("POST /highlight") {
                    self.handleHighlight(connection, initialData: requestData)
                } else if request.contains("POST /db/execute") {
                    self.handleBodyRoute(connection, initialData: requestData) {
                        self.databaseRouteHandler.handleExecuteSql(body: $0)
                    }
                } else if request.contains("POST /db/list") {
                    self.sendRouteResponse(connection, self.databaseRouteHandler.handleListDatabases())
                } else if request.contains("POST /db/capabilities") {
                    self.sendRouteResponse(connection, self.databaseRouteHandler.handleCapabilities())
                } else if request.contains("POST /db/tables") {
                    self.handleBodyRoute(connection, initialData: requestData) {
                        self.databaseRouteHandler.handleListTables(body: $0)
                    }
                } else if request.contains("POST /db/table-data") {
                    self.handleBodyRoute(connection, initialData: requestData) {
                        self.databaseRouteHandler.handleTableData(body: $0)
                    }
                } else if request.contains("POST /db/table-structure") {
                    self.handleBodyRoute(connection, initialData: requestData) {
                        self.databaseRouteHandler.handleTableStructure(body: $0)
                    }
                } else {
                    self.sendResponse(connection, statusCode: 404, body: Data("{\"error\":\"not_found\"}".utf8))
                }
            }
        }
    }

    private func handleHealth(_ connection: NWConnection) {
        let payload = HealthPayload(
            status: "ok",
            bundleId: tracker?.bundleId,
            capabilities: ["network-fault-rules"]
        )
        guard let data = try? JSONEncoder().encode(payload) else {
            sendResponse(connection, statusCode: 500, body: Data("{\"error\":\"encode_failed\"}".utf8))
            return
        }
        sendResponse(connection, statusCode: 200, body: data)
    }

    private func handleCachedHierarchy(_ connection: NWConnection) {
        guard let hierarchy = tracker?.getLatestHierarchy() else {
            sendResponse(connection, statusCode: 204, body: nil)
            return
        }
        guard let data = try? JSONEncoder().encode(hierarchy) else {
            sendResponse(connection, statusCode: 500, body: Data("{\"error\":\"encode_failed\"}".utf8))
            return
        }
        sendResponse(connection, statusCode: 200, body: data)
    }

    private func handleFreshHierarchy(_ connection: NWConnection) {
        guard let tracker else {
            sendResponse(connection, statusCode: 503, body: Data("{\"error\":\"tracker_unavailable\"}".utf8))
            return
        }
        // Already on Network.framework background queue; walkNow() dispatches to main internally
        let hierarchy = tracker.walkNow()
        guard let data = try? JSONEncoder().encode(hierarchy) else {
            sendResponse(connection, statusCode: 500, body: Data("{\"error\":\"encode_failed\"}".utf8))
            return
        }
        sendResponse(connection, statusCode: 200, body: data)
    }

    private func handleNetworkMock(_ connection: NWConnection, initialData: Data) {
        readCompleteHttpBody(connection, initialData: initialData) { [weak self] body in
            guard let self = self else {
                connection.cancel()
                return
            }
            guard let body = body,
                  let payload = try? JSONDecoder().decode(SetMockRulesBody.self, from: body) else {
                self.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                return
            }
            NetworkMockRuleStore.shared.setRules(payload.rules)
            self.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
        }
    }

    private func handleNetworkErrorSimulation(_ connection: NWConnection, initialData: Data) {
        readCompleteHttpBody(connection, initialData: initialData) { [weak self] body in
            guard let self = self else {
                connection.cancel()
                return
            }
            guard let body = body,
                  let payload = try? JSONDecoder().decode(NetworkErrorSimulationDTO.self, from: body) else {
                self.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                return
            }
            NetworkMockRuleStore.shared.setErrorSimulation(payload)
            self.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
        }
    }

    private func handleNetworkFaultRules(_ connection: NWConnection, initialData: Data) {
        readCompleteHttpBody(connection, initialData: initialData) { [weak self] body in
            guard let self else {
                connection.cancel()
                return
            }
            guard let body,
                  let payload = try? JSONDecoder().decode(SetNetworkFaultRulesBody.self, from: body) else {
                self.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                return
            }
            NetworkMockRuleStore.shared.setFaultRules(payload.rules)
            self.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
        }
    }

    private func handleHighlight(_ connection: NWConnection, initialData: Data) {
#if canImport(UIKit)
        readCompleteHttpBody(connection, initialData: initialData) { [weak self] body in
            guard let self = self else {
                connection.cancel()
                return
            }
            guard let body = body,
                  let payload = try? JSONDecoder().decode(SdkAddHighlightBody.self, from: body) else {
                self.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                return
            }
            guard SdkHighlightOverlayManager.shared.show(id: payload.id, shape: payload.shape) else {
                self.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"highlight_failed\"}".utf8))
                return
            }
            self.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
        }
#else
        sendResponse(connection, statusCode: 503, body: Data("{\"error\":\"highlight_unavailable\"}".utf8))
#endif
    }

    private func handleBodyRoute(
        _ connection: NWConnection,
        initialData: Data,
        route: @escaping (Data) -> SdkRouteResponse
    ) {
        readCompleteHttpBody(connection, initialData: initialData) { [weak self] body in
            guard let self = self else {
                connection.cancel()
                return
            }
            self.sendRouteResponse(connection, route(body ?? Data()))
        }
    }

    private func readCompleteHttpHeaders(
        _ connection: NWConnection,
        initialData: Data,
        completion: @escaping (Data?) -> Void
    ) {
        if initialData.range(of: Self.httpHeaderDelimiter) != nil {
            completion(initialData)
            return
        }

        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            if error != nil {
                completion(nil)
                return
            }

            var nextData = initialData
            if let data = data {
                nextData.append(data)
            }

            if nextData.range(of: Self.httpHeaderDelimiter) != nil {
                completion(nextData)
                return
            }
            if isComplete {
                completion(nil)
                return
            }

            guard let self = self else {
                completion(nil)
                return
            }

            self.readCompleteHttpHeaders(connection, initialData: nextData, completion: completion)
        }
    }

    private func readCompleteHttpBody(
        _ connection: NWConnection,
        initialData: Data,
        completion: @escaping (Data?) -> Void
    ) {
        guard let range = initialData.range(of: Self.httpHeaderDelimiter) else {
            completion(nil)
            return
        }

        let headerData = initialData[..<range.lowerBound]
        let body = Data(initialData[range.upperBound...])
        guard let contentLength = Self.contentLength(from: Data(headerData)) else {
            completion(body)
            return
        }
        guard contentLength >= 0 else {
            completion(nil)
            return
        }
        guard contentLength <= Self.maxHttpBodyBytes else {
            completion(nil)
            return
        }

        if body.count >= contentLength {
            completion(Data(body.prefix(contentLength)))
            return
        }

        receiveRemainingHttpBody(
            connection,
            accumulatedBody: body,
            expectedLength: contentLength,
            completion: completion
        )
    }

    private func receiveRemainingHttpBody(
        _ connection: NWConnection,
        accumulatedBody: Data,
        expectedLength: Int,
        completion: @escaping (Data?) -> Void
    ) {
        let remainingLength = expectedLength - accumulatedBody.count
        guard remainingLength > 0 else {
            completion(Data(accumulatedBody.prefix(expectedLength)))
            return
        }

        connection.receive(minimumIncompleteLength: 1, maximumLength: min(65536, remainingLength)) { [weak self] data, _, isComplete, error in
            if error != nil {
                completion(nil)
                return
            }

            var nextBody = accumulatedBody
            if let data = data {
                nextBody.append(data)
            }

            if nextBody.count >= expectedLength {
                completion(Data(nextBody.prefix(expectedLength)))
                return
            }
            if isComplete {
                completion(nil)
                return
            }

            guard let self = self else {
                completion(nil)
                return
            }

            self.receiveRemainingHttpBody(
                connection,
                accumulatedBody: nextBody,
                expectedLength: expectedLength,
                completion: completion
            )
        }
    }

    private static func contentLength(from headerData: Data) -> Int? {
        guard let headers = String(data: headerData, encoding: .utf8) else { return nil }
        for line in headers.components(separatedBy: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            if parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                return Int(parts[1].trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }

    private static func httpHeaderData(from data: Data) -> Data? {
        guard let range = data.range(of: httpHeaderDelimiter) else { return nil }
        return Data(data[..<range.lowerBound])
    }

    private func sendResponse(_ connection: NWConnection, statusCode: Int, body: Data?) {
        let statusText: String
        switch statusCode {
        case 200: statusText = "OK"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        case 503: statusText = "Service Unavailable"
        default: statusText = "Unknown"
        }

        let bodyData = body ?? Data()
        var header = "HTTP/1.1 \(statusCode) \(statusText)\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(bodyData.count)\r\n"
        header += "Connection: close\r\n"
        header += "\r\n"

        var responseData = Data(header.utf8)
        responseData.append(bodyData)

        connection.send(content: responseData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func sendRouteResponse(_ connection: NWConnection, _ response: SdkRouteResponse) {
        sendResponse(connection, statusCode: response.statusCode, body: response.body)
    }
}

private struct HealthPayload: Encodable {
    let status: String
    let bundleId: String?
    let capabilities: Set<String>
}

private struct SetMockRulesBody: Decodable {
    let rules: [NetworkMockRuleDTO]
}

private struct SetNetworkFaultRulesBody: Decodable {
    let rules: [NetworkFaultRuleDTO]
}
#endif
