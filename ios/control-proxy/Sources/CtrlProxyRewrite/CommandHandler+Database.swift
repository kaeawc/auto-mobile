import Foundation

extension CommandHandler {
    // MARK: - Database

    func handleExecuteSql(_ request: RequestExecuteSql, startTime: Date) async -> ExecuteSqlResponse {
        guard let client = sdkDatabaseClient else {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let query = request.query else {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("query").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            let result = try await client.executeSQL(
                databasePath: databasePath,
                query: query,
                sessionId: request.sessionId,
                mutationToken: request.mutationToken,
                readOnly: request.readOnly
            )
            if let error = result.error {
                return ExecuteSqlResponse(
                    requestId: request.requestId,
                    success: false,
                    error: error,
                    totalTimeMs: totalTimeMs(from: startTime)
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
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return ExecuteSqlResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleListDatabases(_ request: RequestListDatabases, startTime: Date) async -> ListDatabasesResponse {
        guard let client = sdkDatabaseClient else {
            return ListDatabasesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            return try await ListDatabasesResponse(
                requestId: request.requestId,
                success: true,
                databases: client.listDatabases(),
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return ListDatabasesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleStorageCapabilities(
        _ request: RequestStorageCapabilities,
        startTime: Date
    )
        async -> StorageCapabilitiesResponse
    {
        guard let client = sdkDatabaseClient else {
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            let capabilities = try await client.storageCapabilities()
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: true,
                capabilities: capabilities,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return StorageCapabilitiesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleListTables(_ request: RequestListTables, startTime: Date) async -> ListTablesResponse {
        guard let client = sdkDatabaseClient else {
            return ListTablesResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return ListTablesResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            return try await ListTablesResponse(
                requestId: request.requestId,
                success: true,
                tables: client.listTables(databasePath: databasePath),
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return ListTablesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleGetTableData(_ request: RequestGetTableData, startTime: Date) async -> TableDataResponse {
        guard let client = sdkDatabaseClient else {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let table = request.table else {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("table").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
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
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return TableDataResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
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
        guard let client = sdkDatabaseClient else {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: databaseUnavailableMessage,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let databasePath = request.databasePath else {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("databasePath").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let table = request.table else {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: CommandError.missingParameter("table").localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        do {
            try await validateDatabaseAppId(request.appId)
            let structure = try await client.getTableStructure(databasePath: databasePath, table: table)
            return TableStructureResponse(
                requestId: request.requestId,
                success: true,
                columns: structure.columns,
                diagnostic: structure.diagnostic,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return TableStructureResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
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
