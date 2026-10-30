#if DEBUG && !os(watchOS)
    import AutoMobileSdkWire
    import Foundation
    import Network

    enum SdkRouteTable {
        /// The route set is shared with the runner (`AutoMobileSdkWire`).
        typealias Route = SdkRoute

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

        /// Descriptors retain the existing body-reading and queue boundaries.
        enum Handler: Sendable {
            case simple(@Sendable (SdkHierarchyServer, NWConnection) -> Void)
            case body(@Sendable (SdkHierarchyServer, NWConnection, Data) -> Void)
            case storageQueue(@Sendable (SdkHierarchyServer) -> SdkRouteResponse)
            // Prepare before reading: SQL's budget starts when the route is dispatched.
            case bodyThenStorage(@Sendable (SdkHierarchyServer) -> @Sendable (Data) -> SdkRouteResponse)
        }

        struct Entry: Sendable {
            let route: Route
            let handler: Handler
        }

        static let entries: [Entry] = [
            Entry(route: .freshHierarchy, handler: .simple { $0.handleFreshHierarchy($1) }),
            Entry(route: .cachedHierarchy, handler: .simple { $0.handleCachedHierarchy($1) }),
            Entry(route: .health, handler: .simple { $0.handleHealth($1) }),
            Entry(route: .networkMock, handler: .body { $0.handleNetworkMock($1, initialData: $2) }),
            Entry(
                route: .networkErrorSimulation,
                handler: .body { $0.handleNetworkErrorSimulation($1, initialData: $2) }
            ),
            Entry(route: .networkFaultRules, handler: .body { $0.handleNetworkFaultRules($1, initialData: $2) }),
            Entry(route: .magicTap, handler: .simple { $0.handleMagicTap($1) }),
            Entry(route: .highlight, handler: .body { $0.handleHighlight($1, initialData: $2) }),
            Entry(route: .dbExecute, handler: .bodyThenStorage { server in
                let receivedAt = SdkDatabaseBudget.now()
                return { server.databaseRouteHandler.handleExecuteSql(body: $0, receivedAt: receivedAt) }
            }),
            Entry(route: .dbList, handler: .storageQueue { $0.databaseRouteHandler.handleListDatabases() }),
            Entry(route: .dbCapabilities, handler: .storageQueue { $0.databaseRouteHandler.handleCapabilities() }),
            Entry(route: .dbTables, handler: .bodyThenStorage { server in
                { server.databaseRouteHandler.handleListTables(body: $0) }
            }),
            Entry(route: .dbTableData, handler: .bodyThenStorage { server in
                { server.databaseRouteHandler.handleTableData(body: $0) }
            }),
            Entry(route: .dbTableStructure, handler: .bodyThenStorage { server in
                { server.databaseRouteHandler.handleTableStructure(body: $0) }
            }),
            Entry(route: .keychainDelete, handler: .bodyThenStorage { server in
                { server.keychainDeletionRouteHandler.handle(body: $0) }
            }),
            Entry(route: .preferences, handler: .bodyThenStorage { server in
                { server.preferenceRouteHandler.handle(body: $0) }
            }),
            Entry(route: .trigger, handler: .body { $0.handleTrigger($1, initialData: $2) }),
            Entry(
                route: .observationSnapshot,
                handler: .body { $0.handleObservationSnapshot($1, initialData: $2) }
            ),
            Entry(route: .observationAction, handler: .body { $0.handleObservationAction($1, initialData: $2) }),
            Entry(route: .webViewSnapshot, handler: .body { $0.handleWebViewSnapshot($1, initialData: $2) }),
            Entry(route: .webViewAction, handler: .body { $0.handleWebViewAction($1, initialData: $2) }),
        ]
    }
#endif
