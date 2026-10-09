import Foundation

/// Async HTTP client relaying SQLite inspection to the SDK's in-app server.
/// The shared endpoint resolver verifies simulator identity before any database data
/// is decoded. Fixed endpoint/transport injection retains the existing test seam.
public final class SdkDatabaseClient: SdkDatabaseFetching, Sendable {
    /// How long a relayed request waits for the SDK's answer. Sent with `/db/execute` as
    /// `relayTimeoutMs` so the SDK stops waiting on a locked database, and never starts a write, before
    /// this runs out (#10166).
    static let requestTimeout: TimeInterval = 2

    private let baseURL: URL
    private let endpointResolver: SdkEndpointResolver?
    private let transport: any HTTPRequesting

    public convenience init(port: UInt16 = 8766) {
        self.init(port: port, endpointResolver: .production(legacyPort: port))
    }

    convenience init(port: UInt16 = 8766, endpointResolver: SdkEndpointResolver) {
        let baseURL = URL(string: "http://127.0.0.1:\(port)")! // swiftlint:disable:this force_unwrapping
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Self.requestTimeout
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.init(
            baseURL: baseURL,
            transport: URLSessionHTTPTransport(session: URLSession(configuration: config)),
            endpointResolver: endpointResolver
        )
    }

    /// Designated initializer over the `HTTPRequesting` seam (tests inject stubs).
    init(baseURL: URL, transport: any HTTPRequesting, endpointResolver: SdkEndpointResolver? = nil) {
        self.baseURL = baseURL
        self.endpointResolver = endpointResolver
        self.transport = transport
    }

    public func executeSQL(
        databasePath: String,
        query: String,
        sessionId: String? = nil,
        mutationToken: String? = nil,
        readOnly: Bool? = nil
    )
        async throws -> SdkExecuteSqlResult
    {
        try await post(
            path: Self.executePath,
            body: ExecuteSqlRequest(
                databasePath: databasePath,
                query: query,
                sessionId: sessionId,
                mutationToken: mutationToken,
                readOnly: readOnly,
                relayTimeoutMs: Int(Self.requestTimeout * 1000)
            )
        )
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
        let payload: ListTablesPayload = try await post(
            path: "/db/tables",
            body: DatabasePathRequest(databasePath: databasePath)
        )
        return payload.tables
    }

    public func getTableData(
        databasePath: String,
        table: String,
        limit: Int,
        offset: Int
    )
        async throws -> SdkTableDataResult
    {
        try await post(
            path: "/db/table-data",
            body: TableDataRequest(databasePath: databasePath, table: table, limit: limit, offset: offset)
        )
    }

    public func getTableStructure(databasePath: String, table: String) async throws -> SdkTableStructureResult {
        try await post(
            path: "/db/table-structure",
            body: TableStructureRequest(databasePath: databasePath, table: table)
        )
    }

    // MARK: - Private

    private func post<RequestBody: Encodable, ResponseBody: Decodable>(
        path: String,
        body: RequestBody
    )
        async throws -> ResponseBody
    {
        let data = try await requestData(path: path, body: JSONEncoder().encode(body))
        return try JSONDecoder().decode(ResponseBody.self, from: data)
    }

    private func requestData(path: String, body: Data) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        do {
            let (data, response) = try await SdkEndpointResolver.requestData(
                for: request, transport: transport, resolver: endpointResolver
            )
            guard let http = response as? HTTPURLResponse else {
                throw SdkDatabaseError.badResponse("database inspection returned a non-HTTP response")
            }
            guard (200 ..< 300).contains(http.statusCode) else {
                let message = (try? JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: data).error)
                    ?? "HTTP \(http.statusCode)"
                if message == Self.busyCode { throw SdkDatabaseError.busy }
                throw SdkDatabaseError.unavailable("\(Self.unavailableMessage): \(message)")
            }
            return data
        } catch let SdkEndpointError.wrongSimulator(expected, actual) {
            throw SdkDatabaseError.wrongSimulator(expectedUdid: expected, actualUdid: actual)
        } catch let error as SdkDatabaseError {
            throw error
        } catch let error as URLError where path == Self.executePath && Self.mayHaveReachedTheSdk(error) {
            // `/db/execute` can carry a write; after a send, silence is not failure.
            throw SdkDatabaseError.outcomeIndeterminate
        } catch {
            throw SdkDatabaseError.unavailable("\(Self.unavailableMessage): \(error.localizedDescription)")
        }
    }

    /// The SDK's `busy_lock` wire code (HTTP 503), kept in step with `SdkDatabaseRouteHandler.busyCode`.
    static let busyCode = "busy_lock"

    private static let executePath = "/db/execute"

    /// Timeout and a dropped connection both happen after the request left the runner.
    private static func mayHaveReachedTheSdk(_ error: URLError) -> Bool {
        error.code == .timedOut || error.code == .networkConnectionLost
    }

    private static let unavailableMessage =
        "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"
}

private struct SdkDatabaseErrorPayload: Codable {
    let error: String
}

private struct ExecuteSqlRequest: Codable {
    let databasePath: String
    let query: String
    let sessionId: String?
    let mutationToken: String?
    let readOnly: Bool?
    let relayTimeoutMs: Int
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
