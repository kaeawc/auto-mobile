import Foundation

extension CommandHandler {
    // MARK: - Database

    func handleExecuteSql(_ request: RequestExecuteSql, startTime: Date) async -> ExecuteSqlResponse {
        await respond(requestId: request.requestId, startTime: startTime) {
            guard let client = self.sdkDatabaseClient else {
                throw VerbatimLocalizedError(message: self.databaseUnavailableMessage)
            }
            guard let databasePath = request.databasePath else {
                throw CommandError.missingParameter("databasePath")
            }
            guard let query = request.query else {
                throw CommandError.missingParameter("query")
            }

            try await self.validateDatabaseAppId(request.appId)
            let result = try await client.executeSQL(
                databasePath: databasePath,
                query: query,
                sessionId: request.sessionId,
                mutationToken: request.mutationToken,
                readOnly: request.readOnly
            )
            if let error = result.error {
                return ExecuteSqlResponse.failure(
                    requestId: request.requestId,
                    error: error,
                    totalTimeMs: self.totalTimeMs(from: startTime)
                )
            }
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: true,
                queryType: result.queryType,
                columns: result.columns,
                rows: result.rows,
                rowsAffected: result.rowsAffected,
                diagnostic: result.diagnostic,
                truncated: result.truncated,
                totalTimeMs: self.totalTimeMs(from: startTime)
            )
        }
    }

    func handleListDatabases(_ request: RequestListDatabases, startTime: Date) async -> ListDatabasesResponse {
        await respond(requestId: request.requestId, startTime: startTime) {
            guard let client = self.sdkDatabaseClient else {
                throw VerbatimLocalizedError(message: self.databaseUnavailableMessage)
            }
            try await self.validateDatabaseAppId(request.appId)
            return try await ListDatabasesResponse(
                requestId: request.requestId,
                success: true,
                databases: client.listDatabases(),
                totalTimeMs: self.totalTimeMs(from: startTime)
            )
        }
    }

    func handleStorageCapabilities(
        _ request: RequestStorageCapabilities,
        startTime: Date
    )
        async -> StorageCapabilitiesResponse
    {
        await respond(requestId: request.requestId, startTime: startTime) {
            guard let client = self.sdkDatabaseClient else {
                throw VerbatimLocalizedError(message: self.databaseUnavailableMessage)
            }
            try await self.validateDatabaseAppId(request.appId)
            let capabilities = try await client.storageCapabilities()
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: true,
                capabilities: capabilities,
                totalTimeMs: self.totalTimeMs(from: startTime)
            )
        }
    }

    func handleListTables(_ request: RequestListTables, startTime: Date) async -> ListTablesResponse {
        await respond(requestId: request.requestId, startTime: startTime) {
            guard let client = self.sdkDatabaseClient else {
                throw VerbatimLocalizedError(message: self.databaseUnavailableMessage)
            }
            guard let databasePath = request.databasePath else {
                throw CommandError.missingParameter("databasePath")
            }

            try await self.validateDatabaseAppId(request.appId)
            return try await ListTablesResponse(
                requestId: request.requestId,
                success: true,
                tables: client.listTables(databasePath: databasePath),
                totalTimeMs: self.totalTimeMs(from: startTime)
            )
        }
    }

    func handleGetTableData(_ request: RequestGetTableData, startTime: Date) async -> TableDataResponse {
        await respond(requestId: request.requestId, startTime: startTime) {
            guard let client = self.sdkDatabaseClient else {
                throw VerbatimLocalizedError(message: self.databaseUnavailableMessage)
            }
            guard let databasePath = request.databasePath else {
                throw CommandError.missingParameter("databasePath")
            }
            guard let table = request.table else {
                throw CommandError.missingParameter("table")
            }

            try await self.validateDatabaseAppId(request.appId)
            let data = try await client.getTableData(
                databasePath: databasePath,
                table: table,
                limit: request.limit ?? 50,
                offset: Self.sanitizedTableOffset(request.offset)
            )
            return TableDataResponse(
                requestId: request.requestId,
                success: true,
                columns: data.columns,
                rows: data.rows,
                total: data.total,
                diagnostic: data.diagnostic,
                totalTimeMs: self.totalTimeMs(from: startTime)
            )
        }
    }

    /// Convert a wire-supplied table `offset` into a safe non-negative `Int`. `offset` is
    /// decoded as a `Double` and is untrusted: a non-finite value or a magnitude beyond
    /// `Int64` would trap `Int(_:)` and crash the runner (#3616). Non-finite/negative → 0;
    /// values at/above `Int.max` clamp to `Int.max`.
    static func sanitizedTableOffset(_ value: Double?) -> Int {
        guard let value = value, value.isFinite, value >= 0 else { return 0 }
        if value >= Double(Int.max) { return Int.max }
        return Int(value)
    }

    func handleGetTableStructure(
        _ request: RequestGetTableStructure,
        startTime: Date
    )
        async -> TableStructureResponse
    {
        await respond(requestId: request.requestId, startTime: startTime) {
            guard let client = self.sdkDatabaseClient else {
                throw VerbatimLocalizedError(message: self.databaseUnavailableMessage)
            }
            guard let databasePath = request.databasePath else {
                throw CommandError.missingParameter("databasePath")
            }
            guard let table = request.table else {
                throw CommandError.missingParameter("table")
            }

            try await self.validateDatabaseAppId(request.appId)
            let structure = try await client.getTableStructure(databasePath: databasePath, table: table)
            return TableStructureResponse(
                requestId: request.requestId,
                success: true,
                columns: structure.columns,
                diagnostic: structure.diagnostic,
                totalTimeMs: self.totalTimeMs(from: startTime)
            )
        }
    }

    // MARK: - Helpers

    private var databaseUnavailableMessage: String {
        "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"
    }

    private func validateDatabaseAppId(_ appId: String?) async throws {
        guard let requestedAppId = normalizedBundleId(appId) else {
            throw CommandError.missingParameter("appId")
        }

        guard let foregroundAppId = normalizedBundleId(await elementLocator.refreshForegroundBundleId()),
              foregroundAppId == requestedAppId
        else {
            throw CommandError.executionFailed(
                "Database inspection requires requested appId \(requestedAppId) to be the foreground app"
            )
        }

        guard let serverAppId = normalizedBundleId(await sdkHierarchyClient?.fetchServerInfo()?.bundleId) else {
            throw CommandError.executionFailed(
                "\(databaseUnavailableMessage); unable to verify SDK server bundle for requested appId \(requestedAppId)"
            )
        }

        guard serverAppId == requestedAppId else {
            throw CommandError.executionFailed(
                "SDK server bundle \(serverAppId) does not match requested appId \(requestedAppId)"
            )
        }
    }
}
