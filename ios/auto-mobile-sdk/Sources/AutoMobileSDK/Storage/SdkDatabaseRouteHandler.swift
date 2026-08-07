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

        init(databasePath: String, query: String, sessionId: String? = nil) {
            self.databasePath = databasePath
            self.query = query
            self.sessionId = sessionId
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            databasePath = try container.decode(String.self, forKey: .databasePath)
            query = try container.decode(String.self, forKey: .query)
            sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
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
        func handleCapabilities() -> SdkRouteResponse {
            let configuration = DatabaseInspector.shared.inspectionConfiguration
            return encode(SdkStorageCapabilitiesPayload(
                readOnly: !configuration.allowMutations,
                mutationAuthorized: DatabaseInspector.shared.canMutate(
                    sessionId: AutoMobileSDK.shared.currentSessionId(),
                    currentSessionId: AutoMobileSDK.shared.currentSessionId()
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

            return encode(SdkTablesPayload(tables: driver.getTables(databasePath: request.databasePath)))
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
            guard isKnownTable(request.table, databasePath: request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_table")
            }

            let result = driver.getTableData(
                databasePath: request.databasePath,
                table: request.table,
                limit: min(max(request.limit, 1), DatabaseInspector.shared.inspectionConfiguration.maxRows),
                offset: max(request.offset, 0)
            )
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
            guard isKnownTable(request.table, databasePath: request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_table")
            }

            let result = driver.getTableStructure(databasePath: request.databasePath, table: request.table)
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

        func handleExecuteSql(body: Data) -> SdkRouteResponse {
            guard let driver = DatabaseInspector.shared.getDriver() else {
                return error(statusCode: 503, code: "db_inspection_disabled")
            }
            guard let request = try? JSONDecoder().decode(SdkExecuteSqlRequest.self, from: body) else {
                return error(statusCode: 400, code: "bad_request")
            }
            guard isKnownDatabasePath(request.databasePath, driver: driver) else {
                return error(statusCode: 404, code: "unknown_database_path")
            }

            if !isReadOnlyQuery(request.query)
                && !DatabaseInspector.shared.canMutate(
                    sessionId: request.sessionId,
                    currentSessionId: AutoMobileSDK.shared.currentSessionId()
                ) {
                return error(statusCode: 403, code: "mutation_not_authorized")
            }
            let result = driver.executeSQL(databasePath: request.databasePath, query: request.query)
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
                truncated: result.truncated
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

        private func isKnownTable(_ table: String, databasePath: String, driver: DatabaseDriver) -> Bool {
            driver.getTables(databasePath: databasePath).contains(table)
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
        ) -> SdkRouteResponse {
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
        ) -> SdkRouteResponse {
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

        private func isReadOnlyQuery(_ query: String) -> Bool {
            let keyword = query.trimmingCharacters(in: .whitespacesAndNewlines)
                .split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
                .first?
                .uppercased()
            return keyword == "SELECT" || keyword == "EXPLAIN"
                || keyword == "PRAGMA" && !query.contains("=")
                || keyword == "WITH" && !query.localizedCaseInsensitiveContains("INSERT")
                    && !query.localizedCaseInsensitiveContains("UPDATE")
                    && !query.localizedCaseInsensitiveContains("DELETE")
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
