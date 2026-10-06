#if DEBUG && !os(watchOS)
    import Foundation

    struct SdkRouteResponse {
        let statusCode: Int
        let body: Data
    }

    struct SdkExecuteSqlRequest: Codable {
        let databasePath: String
        let query: String
        let sessionId: String?
        let mutationToken: String?
        /// How long the runner waits for this response. Optional: older runners do not send it.
        let relayTimeoutMs: Int?

        init(
            databasePath: String,
            query: String,
            sessionId: String? = nil,
            mutationToken: String? = nil,
            relayTimeoutMs: Int? = nil
        ) {
            self.databasePath = databasePath
            self.query = query
            self.sessionId = sessionId
            self.mutationToken = mutationToken
            self.relayTimeoutMs = relayTimeoutMs
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            databasePath = try container.decode(String.self, forKey: .databasePath)
            query = try container.decode(String.self, forKey: .query)
            sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            mutationToken = try container.decodeIfPresent(String.self, forKey: .mutationToken)
            relayTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .relayTimeoutMs)
        }
    }

    struct SdkDatabasePathRequest: Codable {
        let databasePath: String
    }

    struct SdkTableDataRequest: Codable {
        let databasePath: String
        let table: String
        let limit: Int
        let offset: Int
    }

    struct SdkTableStructureRequest: Codable {
        let databasePath: String
        let table: String
    }

    struct SdkExecuteSqlPayload: Codable {
        let queryType: String
        let columns: [String]?
        let rows: [[String?]]?
        let rowsAffected: Int
        let error: String?
        let diagnostic: StorageDiagnostic?
        let truncated: Bool
    }

    struct SdkDatabaseListPayload: Codable {
        let databases: [SdkDatabaseDescriptorPayload]
    }

    struct SdkStorageCapabilitiesPayload: Codable {
        let readOnly: Bool
        let mutationAuthorized: Bool
        let registeredAppGroupSuites: [String]
        let coreDataStores: [CoreDataStoreRegistration]
        let unavailableStores: [String]
    }

    struct SdkDatabaseDescriptorPayload: Codable {
        let name: String
        let path: String
        let sizeBytes: Int64
    }

    struct SdkTablesPayload: Codable {
        let tables: [String]
    }

    struct SdkTableDataPayload: Codable {
        let columns: [String]
        let rows: [[String?]]
        let total: Int
        let diagnostic: StorageDiagnostic?
    }

    struct SdkTableStructurePayload: Codable {
        let columns: [SdkColumnInfoPayload]
        let diagnostic: StorageDiagnostic?
    }

    struct SdkColumnInfoPayload: Codable {
        let name: String
        let type: String
        let nullable: Bool
        let primaryKey: Bool
        let defaultValue: String?
    }

    struct SdkDatabaseErrorPayload: Codable {
        let error: String
        let diagnostic: StorageDiagnostic?
    }

    final class SdkDatabaseRouteHandler {
        /// Wire code (HTTP 503) for a database the app holds locked past the SDK's bounded wait. Same
        /// string as the driver's `busy_lock` diagnostic.
        static let busyCode = "busy_lock"

        private let currentSessionId: () -> String?

        init(currentSessionId: @escaping () -> String? = { AutoMobileSDK.shared.currentSessionId() }) {
            self.currentSessionId = currentSessionId
        }

        func handleCapabilities() -> SdkRouteResponse {
            let configuration = DatabaseInspector.shared.inspectionConfiguration
            return encode(SdkStorageCapabilitiesPayload(
                readOnly: !configuration.allowMutations,
                mutationAuthorized: DatabaseInspector.shared.canMutate(
                    sessionId: currentSessionId(),
                    currentSessionId: currentSessionId()
                ),
                registeredAppGroupSuites: configuration.registeredAppGroupSuites.sorted(),
                coreDataStores: configuration.coreDataStores,
                unavailableStores: ["keychain", "file_caches"]
            ))
        }

        func handleListDatabases() -> SdkRouteResponse {
            guard let driver = DatabaseInspector.shared.getDriver() else {
                return error(statusCode: 503, code: "db_inspection_disabled")
            }

            let configuration = DatabaseInspector.shared.inspectionConfiguration
            let databases = driver.getDatabases().filter { descriptor in
                configuration.allowedDatabasePaths.contains(descriptor.path)
            }.map {
                SdkDatabaseDescriptorPayload(name: $0.name, path: $0.path, sizeBytes: $0.sizeBytes)
            }
            return encode(SdkDatabaseListPayload(databases: databases))
        }

        func handleListTables(body: Data) -> SdkRouteResponse {
            guard let driver = DatabaseInspector.shared.getDriver() else {
                return error(statusCode: 503, code: "db_inspection_disabled")
            }
            guard let request = try? JSONDecoder().decode(SdkDatabasePathRequest.self, from: body) else {
                return error(statusCode: 400, code: "bad_request")
            }
            guard isKnownDatabasePath(request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_database_path")
            }

            let lookup = tables(databasePath: request.databasePath, driver: driver)
            if lookup.diagnostic?.code == Self.busyCode {
                return error(statusCode: 503, code: Self.busyCode)
            }
            return encode(SdkTablesPayload(tables: lookup.tables))
        }

        func handleTableData(body: Data) -> SdkRouteResponse {
            guard let driver = DatabaseInspector.shared.getDriver() else {
                return error(statusCode: 503, code: "db_inspection_disabled")
            }
            guard let request = try? JSONDecoder().decode(SdkTableDataRequest.self, from: body) else {
                return error(statusCode: 400, code: "bad_request")
            }
            guard isKnownDatabasePath(request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_database_path")
            }
            switch lookupTable(request.table, databasePath: request.databasePath, driver: driver) {
            case .busy: return error(statusCode: 503, code: Self.busyCode)
            case .missing: return error(statusCode: 404, code: "unknown_table")
            case .found: break
            }

            let result = driver.getTableData(
                databasePath: request.databasePath,
                table: request.table,
                limit: min(max(request.limit, 1), DatabaseInspector.shared.inspectionConfiguration.maxRows),
                offset: max(request.offset, 0)
            )
            if result.diagnostic?.code == Self.busyCode {
                return error(statusCode: 503, code: Self.busyCode)
            }
            let configuration = DatabaseInspector.shared.inspectionConfiguration
            let redacted = StorageInspectionAccess.redactedRows(
                columns: result.columns,
                rows: Array(result.rows.prefix(configuration.maxRows)),
                configuredKeys: configuration.sensitiveKeys
            )
            let bounded = boundRows(redacted, maxBytes: configuration.maxBytes)
            let payload = SdkTableDataPayload(
                columns: result.columns,
                rows: bounded,
                total: result.totalRows,
                diagnostic: result.diagnostic
            )
            return encodeBoundedTableData(payload, maxBytes: configuration.maxBytes)
        }

        func handleTableStructure(body: Data) -> SdkRouteResponse {
            guard let driver = DatabaseInspector.shared.getDriver() else {
                return error(statusCode: 503, code: "db_inspection_disabled")
            }
            guard let request = try? JSONDecoder().decode(SdkTableStructureRequest.self, from: body) else {
                return error(statusCode: 400, code: "bad_request")
            }
            guard isKnownDatabasePath(request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_database_path")
            }
            switch lookupTable(request.table, databasePath: request.databasePath, driver: driver) {
            case .busy: return error(statusCode: 503, code: Self.busyCode)
            case .missing: return error(statusCode: 404, code: "unknown_table")
            case .found: break
            }

            let result = driver.getTableStructure(databasePath: request.databasePath, table: request.table)
            if result.diagnostic?.code == Self.busyCode {
                return error(statusCode: 503, code: Self.busyCode)
            }
            let configuration = DatabaseInspector.shared.inspectionConfiguration
            return encode(SdkTableStructurePayload(columns: result.columns.map {
                SdkColumnInfoPayload(
                    name: $0.name,
                    type: $0.type,
                    nullable: $0.isNullable,
                    primaryKey: $0.isPrimaryKey,
                    defaultValue: StorageInspectionAccess.isSensitive(
                        $0.name,
                        configured: configuration.sensitiveKeys
                    ) ? "[REDACTED]" : $0.defaultValue
                )
            }, diagnostic: result.diagnostic))
        }

        /// `receivedAt` is when the server accepted the request, before any queueing, so time spent
        /// waiting behind other database work counts against the relay's timeout.
        func handleExecuteSql(body: Data, receivedAt: TimeInterval = SdkDatabaseBudget.now()) -> SdkRouteResponse {
            guard let driver = DatabaseInspector.shared.getDriver() else {
                return error(statusCode: 503, code: "db_inspection_disabled")
            }
            guard let request = try? JSONDecoder().decode(SdkExecuteSqlRequest.self, from: body) else {
                return error(statusCode: 400, code: "bad_request")
            }
            guard isKnownDatabasePath(request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_database_path")
            }

            let classification = classify(request, driver: driver)
            if classification.isBusy {
                return error(statusCode: 503, code: Self.busyCode)
            }
            if classification.hasMultipleStatements {
                return error(statusCode: 400, code: "multiple_statements_not_supported")
            }
            if classification.requiresWriteConnection
                && !DatabaseInspector.shared.canMutate(
                    sessionId: request.sessionId,
                    currentSessionId: currentSessionId(),
                    mutationToken: request.mutationToken
                )
            {
                return error(statusCode: 403, code: "mutation_not_authorized")
            }
            let result = execute(request, driver: driver, receivedAt: receivedAt)
            if result.diagnostic?.code == Self.busyCode {
                return error(statusCode: 503, code: Self.busyCode)
            }
            let configuration = DatabaseInspector.shared.inspectionConfiguration
            let columns = result.columns
            let rows = columns.map {
                boundRows(
                    StorageInspectionAccess.redactedRows(
                        columns: $0,
                        rows: Array((result.rows ?? []).prefix(configuration.maxRows)),
                        configuredKeys: configuration.sensitiveKeys
                    ),
                    maxBytes: configuration.maxBytes
                )
            }
            let payload = SdkExecuteSqlPayload(
                queryType: result.columns == nil ? "mutation" : "query",
                columns: columns,
                rows: rows,
                rowsAffected: result.rowsAffected,
                error: result.error,
                diagnostic: result.diagnostic,
                truncated: result.truncated || (rows?.count ?? 0) < (result.rows?.count ?? 0)
            )
            return encodeBoundedExecuteSql(payload, maxBytes: configuration.maxBytes)
        }

        private func isKnownDatabasePath(_ databasePath: String, driver: DatabaseDriver) -> Bool {
            let configuration = DatabaseInspector.shared.inspectionConfiguration
            return driver.getDatabases().contains { descriptor in
                descriptor.path == databasePath
                    && configuration.allowedDatabasePaths.contains(databasePath)
            }
        }

        private enum TableLookup {
            case found
            case missing
            case busy
        }

        /// A lock held by the app must not read as "no such table" (#10165).
        private func lookupTable(_ table: String, databasePath: String, driver: DatabaseDriver) -> TableLookup {
            let lookup = tables(databasePath: databasePath, driver: driver)
            if lookup.diagnostic?.code == Self.busyCode { return .busy }
            return lookup.tables.contains(table) ? .found : .missing
        }

        private func tables(
            databasePath: String,
            driver: DatabaseDriver
        )
            -> (tables: [String], diagnostic: StorageDiagnostic?)
        {
            if let sqlite = driver as? SQLiteDatabaseDriver {
                let result = sqlite.tablesResult(databasePath: databasePath)
                return (result.tables, result.diagnostic)
            }
            return (driver.getTables(databasePath: databasePath), nil)
        }

        private func execute(
            _ request: SdkExecuteSqlRequest,
            driver: DatabaseDriver,
            receivedAt: TimeInterval
        )
            -> SQLExecutionResult
        {
            guard let sqlite = driver as? SQLiteDatabaseDriver else {
                return driver.executeSQL(databasePath: request.databasePath, query: request.query)
            }
            return sqlite.executeSQL(
                databasePath: request.databasePath,
                query: request.query,
                deadline: SdkDatabaseBudget.mutationDeadline(
                    receivedAt: receivedAt,
                    relayTimeoutMs: request.relayTimeoutMs
                )
            )
        }

        private func classify(_ request: SdkExecuteSqlRequest, driver: DatabaseDriver) -> SQLClassification {
            if let sqlite = driver as? SQLiteDatabaseDriver {
                return sqlite.classify(databasePath: request.databasePath, query: request.query)
            }
            return SQLiteDatabaseDriver.classifySQL(
                databasePath: request.databasePath,
                query: request.query,
                allowSyntaxFallback: true
            )
        }

        private func encode<T: Encodable>(_ payload: T) -> SdkRouteResponse {
            guard let data = try? JSONEncoder().encode(payload) else {
                return error(statusCode: 500, code: "encode_failed")
            }
            return SdkRouteResponse(statusCode: 200, body: data)
        }

        private func encodeBounded<T: Encodable>(_ payload: T, maxBytes: Int) -> SdkRouteResponse {
            guard let data = try? JSONEncoder().encode(payload) else {
                return error(statusCode: 500, code: "encode_failed")
            }
            guard data.count <= maxBytes else {
                return error(statusCode: 413, code: "response_too_large")
            }
            return SdkRouteResponse(statusCode: 200, body: data)
        }

        private func encodeBoundedTableData(
            _ payload: SdkTableDataPayload,
            maxBytes: Int
        )
            -> SdkRouteResponse
        {
            var rows = payload.rows
            while true {
                let candidate = SdkTableDataPayload(
                    columns: payload.columns,
                    rows: rows,
                    total: payload.total,
                    diagnostic: payload.diagnostic
                )
                guard let data = try? JSONEncoder().encode(candidate) else {
                    return error(statusCode: 500, code: "encode_failed")
                }
                if data.count <= maxBytes {
                    return SdkRouteResponse(statusCode: 200, body: data)
                }
                guard !rows.isEmpty else {
                    return error(statusCode: 413, code: "response_too_large")
                }
                rows.removeLast()
            }
        }

        private func encodeBoundedExecuteSql(
            _ payload: SdkExecuteSqlPayload,
            maxBytes: Int
        )
            -> SdkRouteResponse
        {
            var rows = payload.rows ?? []
            while true {
                let candidate = SdkExecuteSqlPayload(
                    queryType: payload.queryType,
                    columns: payload.columns,
                    rows: rows,
                    rowsAffected: payload.rowsAffected,
                    error: payload.error,
                    diagnostic: payload.diagnostic,
                    truncated: payload.truncated || rows.count < (payload.rows?.count ?? 0)
                )
                guard let data = try? JSONEncoder().encode(candidate) else {
                    return error(statusCode: 500, code: "encode_failed")
                }
                if data.count <= maxBytes {
                    return SdkRouteResponse(statusCode: 200, body: data)
                }
                guard !rows.isEmpty else {
                    return error(statusCode: 413, code: "response_too_large")
                }
                rows.removeLast()
            }
        }

        private func error(statusCode: Int, code: String) -> SdkRouteResponse {
            let payload = SdkDatabaseErrorPayload(
                error: code,
                diagnostic: StorageDiagnostic(code: code, message: code)
            )
            let body = (try? JSONEncoder().encode(payload)) ?? Data("{\"error\":\"\(code)\"}".utf8)
            return SdkRouteResponse(statusCode: statusCode, body: body)
        }

        private func boundRows(_ rows: [[String?]], maxBytes: Int) -> [[String?]] {
            var used = 0
            var result: [[String?]] = []
            for row in rows {
                let bytes = row.reduce(0) { $0 + ($1?.utf8.count ?? 0) }
                guard used + bytes <= maxBytes else { break }
                result.append(row)
                used += bytes
            }
            return result
        }
    }
#endif
