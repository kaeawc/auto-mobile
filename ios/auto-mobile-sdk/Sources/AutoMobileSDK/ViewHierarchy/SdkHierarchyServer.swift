#if DEBUG && canImport(UIKit) && !os(watchOS)
import Foundation
import Network

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

    private let lock = NSLock()
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.sdk.hierarchy-server")
    private weak var tracker: ViewHierarchyTracker?
    private let databaseRouteHandler = SdkDatabaseRouteHandler()

    init(tracker: ViewHierarchyTracker) {
        self.tracker = tracker
    }

    // MARK: - Lifecycle

    func start() {
        lock.lock()
        guard listener == nil else {
            lock.unlock()
            return
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true

        do {
            let nwListener = try NWListener(using: parameters, on: NWEndpoint.Port(integerLiteral: Self.port))
            listener = nwListener
            lock.unlock()

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
            lock.unlock()
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

            guard let data, let request = String(data: data, encoding: .utf8) else {
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
                self.handleNetworkMock(connection, data: data)
            } else if request.contains("POST /highlight") {
                self.handleHighlight(connection, data: data)
            } else if request.contains("POST /db/execute") {
                self.sendRouteResponse(
                    connection,
                    self.databaseRouteHandler.handleExecuteSql(body: Self.httpBody(from: data) ?? Data())
                )
            } else if request.contains("POST /db/list") {
                self.sendRouteResponse(connection, self.databaseRouteHandler.handleListDatabases())
            } else if request.contains("POST /db/tables") {
                self.sendRouteResponse(
                    connection,
                    self.databaseRouteHandler.handleListTables(body: Self.httpBody(from: data) ?? Data())
                )
            } else if request.contains("POST /db/table-data") {
                self.sendRouteResponse(
                    connection,
                    self.databaseRouteHandler.handleTableData(body: Self.httpBody(from: data) ?? Data())
                )
            } else if request.contains("POST /db/table-structure") {
                self.sendRouteResponse(
                    connection,
                    self.databaseRouteHandler.handleTableStructure(body: Self.httpBody(from: data) ?? Data())
                )
            } else {
                self.sendResponse(connection, statusCode: 404, body: Data("{\"error\":\"not_found\"}".utf8))
            }
        }
    }

    private func handleHealth(_ connection: NWConnection) {
        let payload = HealthPayload(status: "ok", bundleId: tracker?.bundleId)
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

    private func handleNetworkMock(_ connection: NWConnection, data: Data) {
        guard let body = Self.httpBody(from: data),
              let payload = try? JSONDecoder().decode(SetMockRulesBody.self, from: body) else {
            sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
            return
        }
        NetworkMockRuleStore.shared.setRules(payload.rules)
        sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
    }

    private func handleHighlight(_ connection: NWConnection, data: Data) {
        guard let body = Self.httpBody(from: data),
              let payload = try? JSONDecoder().decode(SdkAddHighlightBody.self, from: body) else {
            sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
            return
        }
        guard SdkHighlightOverlayManager.shared.show(id: payload.id, shape: payload.shape) else {
            sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"highlight_failed\"}".utf8))
            return
        }
        sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
    }

    private static func httpBody(from data: Data) -> Data? {
        let delimiter = Data("\r\n\r\n".utf8)
        guard let range = data.range(of: delimiter) else { return nil }
        return data[range.upperBound...]
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
}

private struct SetMockRulesBody: Decodable {
    let rules: [NetworkMockRuleDTO]
}
#endif
