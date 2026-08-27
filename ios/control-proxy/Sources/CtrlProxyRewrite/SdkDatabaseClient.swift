import Foundation

/// Async HTTP client relaying SQLite inspection to the SDK's in-app server (port 8766).
/// Ported from the reference `SdkDatabaseClient.swift`.
///
/// Rewrite archetype: a **stateless `Sendable`** async client (see `SdkHierarchyClient`).
/// The reference blocked a `URLSession` completion on a `DispatchSemaphore`; this awaits
/// `transport.data(for:)` over the injectable `HTTPRequesting` seam. All stored state is
/// immutable, so the client is `Sendable` with no isolation. The error mapping is ported
/// verbatim: a transport error and a non-2xx status both surface as
/// `SdkDatabaseError.unavailable` (the latter carrying the SDK's error payload when
/// present), a non-HTTP response as `.badResponse`.
public final class SdkDatabaseClient: SdkDatabaseFetching, Sendable {
    private let baseURL: URL
    private let transport: any HTTPRequesting

    public convenience init(port: UInt16 = 8766) {
        // Hardcoded localhost URL with an integer port always parses.
        let baseURL = URL(string: "http://localhost:\(port)")!
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.init(baseURL: baseURL, transport: URLSessionHTTPTransport(session: URLSession(configuration: config)))
    }

    /// Designated initializer over the `HTTPRequesting` seam (tests inject stubs).
    init(baseURL: URL, transport: any HTTPRequesting) {
        self.baseURL = baseURL
        self.transport = transport
    }

    public func executeSQL(databasePath: String, query: String, sessionId: String? = nil) async throws -> SdkExecuteSqlResult {
        try await post(path: "/db/execute", body: ExecuteSqlRequest(databasePath: databasePath, query: query, sessionId: sessionId))
    }

    public func listDatabases() async throws -> [SdkDatabaseInfo] {
        let payload: ListDatabasesPayload = try await post(path: "/db/list", body: EmptyRequest())
        return payload.databases
    }

    public func storageCapabilities() async throws -> SdkStorageCapabilities {
        let payload: StorageCapabilitiesPayload = try await post(path: "/db/capabilities", body: EmptyRequest())
        return SdkStorageCapabilities(
            readOnly: payload.readOnly,
            mutationAuthorized: payload.mutationAuthorized,
            registeredAppGroupSuites: payload.registeredAppGroupSuites,
            coreDataStores: payload.coreDataStores,
            unavailableStores: payload.unavailableStores
        )
    }

    public func listTables(databasePath: String) async throws -> [String] {
        let payload: ListTablesPayload = try await post(path: "/db/tables", body: DatabasePathRequest(databasePath: databasePath))
        return payload.tables
    }

    public func getTableData(databasePath: String, table: String, limit: Int, offset: Int) async throws -> SdkTableDataResult {
        try await post(
            path: "/db/table-data",
            body: TableDataRequest(databasePath: databasePath, table: table, limit: limit, offset: offset)
        )
    }

    public func getTableStructure(databasePath: String, table: String) async throws -> SdkTableStructureResult {
        try await post(path: "/db/table-structure", body: TableStructureRequest(databasePath: databasePath, table: table))
    }

    // MARK: - Private

    private func post<RequestBody: Encodable, ResponseBody: Decodable>(
        path: String,
        body: RequestBody
    ) async throws -> ResponseBody {
        let data = try await requestData(path: path, body: JSONEncoder().encode(body))
        return try JSONDecoder().decode(ResponseBody.self, from: data)
    }

    private func requestData(path: String, body: Data) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        do {
            let (data, response) = try await transport.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw SdkDatabaseError.badResponse("database inspection returned a non-HTTP response")
            }
            guard (200 ..< 300).contains(http.statusCode) else {
                let message = (try? JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: data).error)
                    ?? "HTTP \(http.statusCode)"
                throw SdkDatabaseError.unavailable("\(Self.unavailableMessage): \(message)")
            }
            return data
        } catch let error as SdkDatabaseError {
            throw error
        } catch {
            throw SdkDatabaseError.unavailable("\(Self.unavailableMessage): \(error.localizedDescription)")
        }
    }

    private static let unavailableMessage = "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"
}

private struct SdkDatabaseErrorPayload: Codable {
    let error: String
}

private struct ExecuteSqlRequest: Codable {
    let databasePath: String
    let query: String
    let sessionId: String?
}

private struct DatabasePathRequest: Codable {
    let databasePath: String
}

private struct TableDataRequest: Codable {
    let databasePath: String
    let table: String
    let limit: Int
    let offset: Int
}

private struct TableStructureRequest: Codable {
    let databasePath: String
    let table: String
}

private struct ListDatabasesPayload: Codable {
    let databases: [SdkDatabaseInfo]
}

private struct StorageCapabilitiesPayload: Codable {
    let readOnly: Bool
    let mutationAuthorized: Bool
    let registeredAppGroupSuites: [String]
    let coreDataStores: [SdkCoreDataStoreRegistration]
    let unavailableStores: [String]
}

private struct ListTablesPayload: Codable {
    let tables: [String]
}

private struct EmptyRequest: Codable {}
