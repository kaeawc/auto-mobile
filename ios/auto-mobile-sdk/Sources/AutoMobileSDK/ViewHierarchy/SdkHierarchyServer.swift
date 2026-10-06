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
        var isApplicationActive: Bool { get }
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

    /// Minimal HTTP server running inside the target app on a simulator-specific port.
    /// Port 8766 remains a best-effort compatibility listener (the sole port on devices).
    /// Serves view hierarchy snapshots to control-proxy on demand.
    ///
    /// Endpoints:
    /// - `GET /health` -> status, bundle ID, capabilities, and optional simulator UDID
    /// - `GET /hierarchy` -> latest cached hierarchy (fast, no main-thread work)
    /// - `GET /hierarchy/fresh` -> synchronous main-thread walk (slower but guaranteed fresh)
    /// - `POST /accessibility/magic-tap` -> invoke the app responder chain, returning handled
    /// - `POST /highlight` -> render a debug highlight in the app-under-test process
    final class SdkHierarchyServer: @unchecked Sendable {
        static let port: UInt16 = 8766
        static let bindFailureLogPrefix = "[AutoMobileSDK] SDK_SERVER_BIND_FAILED"
        private static let httpHeaderDelimiter = Data("\r\n\r\n".utf8)
        static let maxHeaderBytes = 16 * 1024
        private static let maxHttpBodyBytes = 1024 * 1024

        enum Route: String, Sendable {
            case cachedHierarchy = "/hierarchy"
            case freshHierarchy = "/hierarchy/fresh"
            case health = "/health"
            case networkMock = "/network/mock"
            case networkErrorSimulation = "/network/error-simulation"
            case networkFaultRules = "/network/fault-rules"
            case magicTap = "/accessibility/magic-tap"
            case highlight = "/highlight"
            case dbExecute = "/db/execute"
            case dbList = "/db/list"
            case dbCapabilities = "/db/capabilities"
            case dbTables = "/db/tables"
            case dbTableData = "/db/table-data"
            case dbTableStructure = "/db/table-structure"
            case preferences = "/preferences"

            var method: String {
                switch self {
                case .cachedHierarchy, .freshHierarchy, .health: return "GET"
                default: return "POST"
                }
            }
        }

        enum RouteMatch: Equatable, Sendable {
            case matched(Route)
            case notFound
            case methodNotAllowed(allowed: [String])
            case malformed
        }

        static func route(forRequestLine requestLine: String) -> RouteMatch {
            // Reject malformed request lines with the same 400 bad_request as body handlers.
            let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
            guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty }), parts[1].hasPrefix("/") else {
                return .malformed
            }
            let path = parts[1].prefix { $0 != "?" && $0 != "#" }
            guard let route = Route(rawValue: String(path)) else { return .notFound }
            guard parts[0] == route.method else { return .methodNotAllowed(allowed: [route.method]) }
            return .matched(route)
        }

        private enum HttpHeaderReadResult: Sendable {
            case complete(Data)
            case tooLarge
            case failed
        }

        private let lock: any NSLocking
        private var listener: (any SdkHierarchyListener)?
        private var legacyListener: (any SdkHierarchyListener)?
        private var listenerToken: UUID?
        private var legacyToken: UUID?
        private var isStarted = false
        private let identity: SdkSimulatorIdentity
        private let warning: (String) -> Void
        private let error: (String) -> Void
        private var bindPlanner = SdkBindPlanner()
        private let listenerFactory: (UInt16) throws -> any SdkHierarchyListener
        private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.sdk.hierarchy-server")
        private weak var tracker: (any SdkHierarchyServing)?
        private let databaseRouteHandler = SdkDatabaseRouteHandler()
        private let preferenceRouteHandler = SdkPreferenceRouteHandler()

        init(
            tracker: any SdkHierarchyServing,
            listenerFactory: (() throws -> any SdkHierarchyListener)? = nil,
            lifecycleLock: any NSLocking = NSLock(),
            identity: SdkSimulatorIdentity = SdkSimulatorIdentity(),
            portListenerFactory: @escaping (UInt16) throws -> any SdkHierarchyListener = {
                try SdkHierarchyServer.makeListener(port: $0)
            },
            warning: @escaping (String) -> Void = { InternalLogger.warning($0) },
            error: @escaping (String) -> Void = { InternalLogger.error($0) }
        ) {
            self.tracker = tracker
            self.identity = identity
            self.warning = warning
            self.error = error
            if let listenerFactory {
                self.listenerFactory = { _ in try listenerFactory() }
            } else {
                self.listenerFactory = portListenerFactory
            }
            lock = lifecycleLock
        }

        // MARK: - Lifecycle

        var bindState: SdkServerBindState {
            lock.lock()
            defer { lock.unlock() }
            return bindPlanner.state
        }

        func start() {
            // Keep assign/configure/start atomic with stop(). NWListener callbacks run
            // asynchronously; fake listeners deliver state changes after start returns.
            lock.lock()
            defer { lock.unlock() }
            guard !isStarted else { return }
            isStarted = true
            advancePrimary(.start)
            if identity.udid != nil {
                startListener(port: Self.port, legacy: true)
            }
        }

        /// Called with the lifecycle lock held. The pure planner owns all primary decisions.
        private func advancePrimary(_ event: SdkBindPlanner.Event) {
            let transition = bindPlanner.next(event, udid: identity.udid)
            let previousState = bindPlanner.state
            bindPlanner = transition.planner
            if case let .failed(ports, reason) = bindPlanner.state, previousState != bindPlanner.state {
                if identity.udid == nil { isStarted = false }
                error(
                    "\(Self.bindFailureLogPrefix) udid=\(identity.udid ?? "none") "
                        + "attemptedPorts=\(ports) lastReason=\(reason)"
                )
            }
            if let port = transition.port {
                startListener(port: port, legacy: false)
            }
        }

        private func startListener(port: UInt16, legacy: Bool) {
            do {
                let nextListener = try listenerFactory(port)
                let token = UUID()
                if legacy {
                    legacyListener = nextListener
                    legacyToken = token
                } else {
                    listener = nextListener
                    listenerToken = token
                }
                nextListener.stateUpdateHandler = { [weak self] state in
                    self?.listenerStateChanged(state, token: token, port: port, legacy: legacy)
                }
                nextListener.newConnectionHandler = { [weak self] connection in
                    self?.handleConnection(connection)
                }
                nextListener.start(queue: queue)
            } catch {
                listenerFailed(port: port, legacy: legacy, reason: String(describing: error))
            }
        }

        private func listenerStateChanged(
            _ state: NWListener.State, token: UUID, port: UInt16, legacy: Bool
        ) {
            lock.lock()
            defer { lock.unlock() }
            // Ignore callbacks from a cancelled probe or an earlier start/stop cycle.
            guard isStarted, token == (legacy ? legacyToken : listenerToken) else { return }
            switch state {
            case .ready:
                if !legacy { advancePrimary(.ready(port)) }
                InternalLogger.debug("[SdkHierarchyServer] Ready on port \(port)")
            case let .failed(error):
                if legacy {
                    let failed = legacyListener
                    legacyListener = nil
                    legacyToken = nil
                    failed?.cancel()
                } else {
                    let failed = listener
                    listener = nil
                    listenerToken = nil
                    failed?.cancel()
                }
                listenerFailed(port: port, legacy: legacy, reason: String(describing: error))
            default:
                break
            }
        }

        private func listenerFailed(port: UInt16, legacy: Bool, reason: String) {
            if legacy {
                // Another simulator may own 8766. The identity-verified listener is sufficient.
                InternalLogger.debug("[SdkHierarchyServer] Legacy port \(port) unavailable: \(reason)")
            } else {
                InternalLogger.debug("[SdkHierarchyServer] Probe port \(port) failed: \(reason)")
                advancePrimary(.failed(reason))
            }
        }

        func stop() {
            lock.lock()
            let listenersToCancel = [listener, legacyListener].compactMap { $0 }
            listener = nil
            legacyListener = nil
            listenerToken = nil
            legacyToken = nil
            isStarted = false
            bindPlanner = SdkBindPlanner()
            lock.unlock()
            for listener in listenersToCancel {
                listener.cancel()
            }
        }

        static func makeListener(port: UInt16 = SdkHierarchyServer.port) throws -> any SdkHierarchyListener {
            let parameters = listenerParameters(port: port)
            return try NWListener(using: parameters)
        }

        static func listenerParameters(port: UInt16 = SdkHierarchyServer.port) -> NWParameters {
            let parameters = NWParameters.tcp
            // Bind the SDK listener to loopback.
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(integerLiteral: port))
            // Simulator-specific ports have a single owner; preserve legacy/device reuse semantics.
            parameters.allowLocalEndpointReuse = port == Self.port
            return parameters
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

                self.readCompleteHttpHeaders(connection, initialData: data) { [weak self] result in
                    guard let self = self else {
                        connection.cancel()
                        return
                    }
                    let requestData: Data
                    switch result {
                    case let .complete(data):
                        requestData = data
                    case .tooLarge:
                        self.sendResponse(
                            connection, statusCode: 431,
                            body: Data("{\"error\":\"request_header_fields_too_large\"}".utf8)
                        )
                        return
                    case .failed:
                        connection.cancel()
                        return
                    }
                    guard let headerData = Self.httpHeaderData(from: requestData),
                          let request = String(data: headerData, encoding: .utf8)
                    else {
                        connection.cancel()
                        return
                    }

                    if let rejection = self.authorizeRequest(headers: request, execute: {
                        guard self.requireApplicationActive(connection) else { return }

                        // Preserve identity authorization first, then the foreground gate, then routing.
                        // Unknown, wrong-method, and malformed requests retain the existing gate responses.
                        let requestLine = request.components(separatedBy: "\r\n")[0]
                        switch Self.route(forRequestLine: requestLine) {
                        case let .matched(route):
                            self.dispatch(route, connection: connection, requestData: requestData)
                        case .notFound:
                            self.sendResponse(connection, statusCode: 404, body: Data("{\"error\":\"not_found\"}".utf8))
                        case let .methodNotAllowed(allowed):
                            self.sendResponse(
                                connection, statusCode: 405,
                                body: Data("{\"error\":\"method_not_allowed\"}".utf8),
                                extraHeaders: [("Allow", allowed.joined(separator: ", "))]
                            )
                        case .malformed:
                            self.sendResponse(
                                connection,
                                statusCode: 400,
                                body: Data("{\"error\":\"bad_request\"}".utf8)
                            )
                        }
                    }) {
                        self.sendRouteResponse(connection, rejection)
                    }
                }
            }
        }

        private func dispatch(_ route: Route, connection: NWConnection, requestData: Data) {
            switch route {
            case .freshHierarchy:
                handleFreshHierarchy(connection)
            case .cachedHierarchy:
                handleCachedHierarchy(connection)
            case .health:
                handleHealth(connection)
            case .networkMock:
                handleNetworkMock(connection, initialData: requestData)
            case .networkErrorSimulation:
                handleNetworkErrorSimulation(connection, initialData: requestData)
            case .networkFaultRules:
                handleNetworkFaultRules(connection, initialData: requestData)
            case .magicTap:
                DispatchQueue.main.async {
                    guard self.requireApplicationActive(connection) else { return }
                    #if canImport(UIKit)
                        let handled = SdkMagicTap.performInApplication()
                        let body = try? JSONEncoder().encode(["handled": handled])
                        self.sendResponse(connection, statusCode: 200, body: body)
                    #else
                        self.sendResponse(connection, statusCode: 501, body: nil)
                    #endif
                }
            case .highlight:
                handleHighlight(connection, initialData: requestData)
            case .dbExecute:
                handleBodyRoute(connection, initialData: requestData) {
                    self.databaseRouteHandler.handleExecuteSql(body: $0)
                }
            case .dbList:
                sendRouteResponse(connection, databaseRouteHandler.handleListDatabases())
            case .dbCapabilities:
                sendRouteResponse(connection, databaseRouteHandler.handleCapabilities())
            case .dbTables:
                handleBodyRoute(connection, initialData: requestData) {
                    self.databaseRouteHandler.handleListTables(body: $0)
                }
            case .dbTableData:
                handleBodyRoute(connection, initialData: requestData) {
                    self.databaseRouteHandler.handleTableData(body: $0)
                }
            case .dbTableStructure:
                handleBodyRoute(connection, initialData: requestData) {
                    self.databaseRouteHandler.handleTableStructure(body: $0)
                }
            case .preferences:
                handleBodyRoute(connection, initialData: requestData) {
                    self.preferenceRouteHandler.handle(body: $0)
                }
            }
        }

        /// Guard before the foreground gate and before reading any body: a wrong
        /// simulator must never reach routing or launch-scoped mutation authorization.
        /// Missing headers deliberately retain old-runner compatibility.
        @discardableResult
        func authorizeRequest(headers: String, execute: () -> Void) -> SdkRouteResponse? {
            if let expected = identity.udid {
                for line in headers.components(separatedBy: "\r\n").dropFirst() {
                    let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    guard parts.count == 2,
                          parts[0].trimmingCharacters(in: .whitespaces).lowercased()
                          == "x-automobile-simulator-udid" else { continue }
                    let actual = parts[1].trimmingCharacters(in: .whitespaces)
                    if actual.lowercased() != expected.lowercased() {
                        let body = try? JSONEncoder().encode([
                            "error": "wrong_simulator", "expectedUdid": expected, "actualUdid": actual,
                        ])
                        return SdkRouteResponse(statusCode: 409, body: body ?? Data())
                    }
                }
            }
            execute()
            return nil
        }

        static var capabilities: Set<String> {
            #if canImport(UIKit)
                ["network-fault-rules", "magic-tap"]
            #else
                ["network-fault-rules"]
            #endif
        }

        func healthResponse() -> SdkRouteResponse {
            let payload = HealthPayload(
                status: "ok",
                bundleId: tracker?.bundleId,
                capabilities: Self.capabilities,
                simulatorUdid: identity.udid
            )
            guard let data = try? JSONEncoder().encode(payload) else {
                return SdkRouteResponse(statusCode: 500, body: Data("{\"error\":\"encode_failed\"}".utf8))
            }
            return SdkRouteResponse(statusCode: 200, body: data)
        }

        private func handleHealth(_ connection: NWConnection) {
            sendRouteResponse(connection, healthResponse())
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

        /// The foreground gate, asserted at a single point so every caller answers a
        /// non-foreground request identically.
        ///
        /// Returns `false` (having already answered the connection) when the app is
        /// not active, so callers can `guard ... else { return }`.
        private func requireApplicationActive(_ connection: NWConnection) -> Bool {
            guard tracker?.isApplicationActive == true else {
                sendResponse(
                    connection,
                    statusCode: 409,
                    body: Data("{\"error\":\"app_not_active\"}".utf8)
                )
                return false
            }
            return true
        }

        /// Read a body-bearing route's body, then run `execute`.
        ///
        /// The foreground check at header-parse time is NOT sufficient for these
        /// routes: the body can arrive in later TCP segments, so an app that was
        /// active when the headers landed may have resigned active by the time the
        /// body completes. The gate is therefore re-asserted here, at execution
        /// time, and a request that loses the foreground mid-read gets exactly the
        /// same `409 app_not_active` answer as one that never had it.
        private func withRequestBody(
            _ connection: NWConnection,
            initialData: Data,
            execute: @escaping @Sendable (SdkHierarchyServer, Data?) -> Void
        ) {
            readCompleteHttpBody(connection, initialData: initialData) { [weak self] body in
                guard let self = self else {
                    connection.cancel()
                    return
                }
                guard self.requireApplicationActive(connection) else { return }
                execute(self, body)
            }
        }

        private func handleNetworkMock(_ connection: NWConnection, initialData: Data) {
            withRequestBody(connection, initialData: initialData) { server, body in
                guard let body = body,
                      let payload = try? JSONDecoder().decode(SetMockRulesBody.self, from: body)
                else {
                    server.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                    return
                }
                NetworkMockRuleStore.shared.setRules(payload.rules)
                server.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
            }
        }

        private func handleNetworkErrorSimulation(_ connection: NWConnection, initialData: Data) {
            withRequestBody(connection, initialData: initialData) { server, body in
                guard let body = body,
                      let payload = try? JSONDecoder().decode(NetworkErrorSimulationDTO.self, from: body)
                else {
                    server.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                    return
                }
                NetworkMockRuleStore.shared.setErrorSimulation(payload)
                server.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
            }
        }

        private func handleNetworkFaultRules(_ connection: NWConnection, initialData: Data) {
            withRequestBody(connection, initialData: initialData) { server, body in
                guard let body,
                      let payload = try? JSONDecoder().decode(SetNetworkFaultRulesBody.self, from: body)
                else {
                    server.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                    return
                }
                NetworkMockRuleStore.shared.setFaultRules(payload.rules)
                server.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
            }
        }

        private func handleHighlight(_ connection: NWConnection, initialData: Data) {
            #if canImport(UIKit)
                withRequestBody(connection, initialData: initialData) { server, body in
                    guard let body = body,
                          let payload = try? JSONDecoder().decode(SdkAddHighlightBody.self, from: body)
                    else {
                        server.sendResponse(connection, statusCode: 400, body: Data("{\"error\":\"bad_request\"}".utf8))
                        return
                    }
                    let rendered: Bool
                    if Thread.isMainThread {
                        // Avoid a sync self-deadlock; the branch proves main-thread execution.
                        rendered = MainActor.assumeIsolated {
                            SdkHighlightOverlayManager.shared.show(id: payload.id, shape: payload.shape)
                        }
                    } else {
                        rendered = DispatchQueue.main.sync {
                            SdkHighlightOverlayManager.shared.show(id: payload.id, shape: payload.shape)
                        }
                    }
                    guard rendered else {
                        server.sendResponse(
                            connection,
                            statusCode: 400,
                            body: Data("{\"error\":\"highlight_failed\"}".utf8)
                        )
                        return
                    }
                    server.sendResponse(connection, statusCode: 200, body: Data("{\"status\":\"ok\"}".utf8))
                }
            #else
                sendResponse(connection, statusCode: 503, body: Data("{\"error\":\"highlight_unavailable\"}".utf8))
            #endif
        }

        private func handleBodyRoute(
            _ connection: NWConnection,
            initialData: Data,
            route: @escaping @Sendable (Data) -> SdkRouteResponse
        ) {
            withRequestBody(connection, initialData: initialData) { server, body in
                server.sendRouteResponse(connection, route(body ?? Data()))
            }
        }

        private func readCompleteHttpHeaders(
            _ connection: NWConnection,
            initialData: Data,
            completion: @escaping @Sendable (HttpHeaderReadResult) -> Void
        ) {
            if let delimiter = initialData.range(of: Self.httpHeaderDelimiter) {
                let headerBytes = initialData.distance(from: initialData.startIndex, to: delimiter.lowerBound)
                completion(headerBytes > Self.maxHeaderBytes ? .tooLarge : .complete(initialData))
                return
            }
            guard initialData.count <= Self.maxHeaderBytes else {
                completion(.tooLarge)
                return
            }

            connection
                .receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
                    guard error == nil, let self else {
                        completion(.failed)
                        return
                    }
                    var nextData = initialData
                    if let data { nextData.append(data) }
                    // Inspect appended bytes even on EOF, so oversized headers always get 431.
                    if isComplete, nextData.range(of: Self.httpHeaderDelimiter) == nil,
                       nextData.count <= Self.maxHeaderBytes
                    {
                        completion(.failed)
                        return
                    }
                    self.readCompleteHttpHeaders(connection, initialData: nextData, completion: completion)
                }
        }

        private func readCompleteHttpBody(
            _ connection: NWConnection,
            initialData: Data,
            completion: @escaping @Sendable (Data?) -> Void
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
            completion: @escaping @Sendable (Data?) -> Void
        ) {
            let remainingLength = expectedLength - accumulatedBody.count
            guard remainingLength > 0 else {
                completion(Data(accumulatedBody.prefix(expectedLength)))
                return
            }

            connection.receive(minimumIncompleteLength: 1, maximumLength: min(
                65536,
                remainingLength
            )) { [weak self] data, _, isComplete, error in
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

        private func sendResponse(
            _ connection: NWConnection, statusCode: Int, body: Data?, extraHeaders: [(String, String)] = []
        ) {
            let statusText: String
            switch statusCode {
            case 200: statusText = "OK"
            case 204: statusText = "No Content"
            case 400: statusText = "Bad Request"
            case 404: statusText = "Not Found"
            case 405: statusText = "Method Not Allowed"
            case 409: statusText = "Conflict"
            case 431: statusText = "Request Header Fields Too Large"
            case 500: statusText = "Internal Server Error"
            case 503: statusText = "Service Unavailable"
            default: statusText = "Unknown"
            }

            let bodyData = body ?? Data()
            var header = "HTTP/1.1 \(statusCode) \(statusText)\r\n"
            header += "Content-Type: application/json\r\n"
            header += "Content-Length: \(bodyData.count)\r\n"
            header += "Connection: close\r\n"
            for (name, value) in extraHeaders {
                header += "\(name): \(value)\r\n"
            }
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
        let simulatorUdid: String?
    }

    private struct SetMockRulesBody: Decodable {
        let rules: [NetworkMockRuleDTO]
    }

    private struct SetNetworkFaultRulesBody: Decodable {
        let rules: [NetworkFaultRuleDTO]
    }
#endif
