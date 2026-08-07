import Foundation

public enum SdkDatabaseError: Error, LocalizedError {
    case unavailable(String)
    case badResponse(String)

    public var errorDescription: String? {
        switch self {
        case let .unavailable(message):
            return message
        case let .badResponse(message):
            return message
        }
    }
}

public struct SdkDatabaseInfo: Codable, Equatable {
    public let name: String
    public let path: String
    public let sizeBytes: Int64?

    public init(name: String, path: String, sizeBytes: Int64? = nil) {
        self.name = name
        self.path = path
        self.sizeBytes = sizeBytes
    }
}

public struct SdkCoreDataStoreRegistration: Codable, Equatable {
    public let identifier: String
    public let modelVersion: String?
    public let entities: [String]

    public init(identifier: String, modelVersion: String?, entities: [String]) {
        self.identifier = identifier
        self.modelVersion = modelVersion
        self.entities = entities
    }
}

public struct SdkStorageCapabilities: Codable, Equatable {
    public let readOnly: Bool
    public let mutationAuthorized: Bool
    public let registeredAppGroupSuites: [String]
    public let coreDataStores: [SdkCoreDataStoreRegistration]
    public let unavailableStores: [String]

    public init(
        readOnly: Bool,
        mutationAuthorized: Bool,
        registeredAppGroupSuites: [String],
        coreDataStores: [SdkCoreDataStoreRegistration],
        unavailableStores: [String]
    ) {
        self.readOnly = readOnly
        self.mutationAuthorized = mutationAuthorized
        self.registeredAppGroupSuites = registeredAppGroupSuites
        self.coreDataStores = coreDataStores
        self.unavailableStores = unavailableStores
    }
}

public struct SdkColumnInfo: Codable, Equatable {
    public let name: String
    public let type: String
    public let nullable: Bool
    public let primaryKey: Bool
    public let defaultValue: String?

    public init(name: String, type: String, nullable: Bool, primaryKey: Bool, defaultValue: String?) {
        self.name = name
        self.type = type
        self.nullable = nullable
        self.primaryKey = primaryKey
        self.defaultValue = defaultValue
    }
}

public struct SdkExecuteSqlResult: Codable, Equatable {
    public let queryType: String
    public let columns: [String]?
    public let rows: [[String?]]?
    public let rowsAffected: Int
    public let error: String?
    public let diagnostic: SdkStorageDiagnostic?
    public let truncated: Bool

    private enum CodingKeys: String, CodingKey {
        case queryType, columns, rows, rowsAffected, error, diagnostic, truncated
    }

    public init(
        queryType: String,
        columns: [String]? = nil,
        rows: [[String?]]? = nil,
        rowsAffected: Int,
        error: String? = nil,
        diagnostic: SdkStorageDiagnostic? = nil,
        truncated: Bool = false
    ) {
        self.queryType = queryType
        self.columns = columns
        self.rows = rows
        self.rowsAffected = rowsAffected
        self.error = error
        self.diagnostic = diagnostic
        self.truncated = truncated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        queryType = try container.decode(String.self, forKey: .queryType)
        columns = try container.decodeIfPresent([String].self, forKey: .columns)
        rows = try container.decodeIfPresent([[String?]].self, forKey: .rows)
        rowsAffected = try container.decode(Int.self, forKey: .rowsAffected)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        diagnostic = try container.decodeIfPresent(SdkStorageDiagnostic.self, forKey: .diagnostic)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

public struct SdkStorageDiagnostic: Codable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct SdkTableDataResult: Codable, Equatable {
    public let columns: [String]
    public let rows: [[String?]]
    public let total: Int
    public let diagnostic: SdkStorageDiagnostic?

    public init(columns: [String], rows: [[String?]], total: Int, diagnostic: SdkStorageDiagnostic? = nil) {
        self.columns = columns
        self.rows = rows
        self.total = total
        self.diagnostic = diagnostic
    }
}

public struct SdkTableStructureResult: Codable, Equatable {
    public let columns: [SdkColumnInfo]
    public let diagnostic: SdkStorageDiagnostic?

    public init(columns: [SdkColumnInfo], diagnostic: SdkStorageDiagnostic? = nil) {
        self.columns = columns
        self.diagnostic = diagnostic
    }
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

public final class SdkDatabaseClient: SdkDatabaseFetching, @unchecked Sendable {
    private let baseURL: URL
    private let urlSession: URLSession

    public init(port: UInt16 = 8766) {
        // Hardcoded localhost URL with an integer port always parses.
        self.baseURL = URL(string: "http://localhost:\(port)")!  // swiftlint:disable:this force_unwrapping
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config)
    }

    public func executeSQL(databasePath: String, query: String, sessionId: String? = nil) throws -> SdkExecuteSqlResult {
        try post(path: "/db/execute", body: ExecuteSqlRequest(databasePath: databasePath, query: query, sessionId: sessionId))
    }

    public func listDatabases() throws -> [SdkDatabaseInfo] {
        let payload: ListDatabasesPayload = try post(path: "/db/list", body: EmptyRequest())
        return payload.databases
    }

    public func storageCapabilities() throws -> SdkStorageCapabilities {
        let payload: StorageCapabilitiesPayload = try post(path: "/db/capabilities", body: EmptyRequest())
        return SdkStorageCapabilities(
            readOnly: payload.readOnly,
            mutationAuthorized: payload.mutationAuthorized,
            registeredAppGroupSuites: payload.registeredAppGroupSuites,
            coreDataStores: payload.coreDataStores,
            unavailableStores: payload.unavailableStores
        )
    }

    public func listTables(databasePath: String) throws -> [String] {
        let payload: ListTablesPayload = try post(path: "/db/tables", body: DatabasePathRequest(databasePath: databasePath))
        return payload.tables
    }

    public func getTableData(databasePath: String, table: String, limit: Int, offset: Int) throws -> SdkTableDataResult {
        try post(
            path: "/db/table-data",
            body: TableDataRequest(databasePath: databasePath, table: table, limit: limit, offset: offset)
        )
    }

    public func getTableStructure(databasePath: String, table: String) throws -> SdkTableStructureResult {
        try post(path: "/db/table-structure", body: TableStructureRequest(databasePath: databasePath, table: table))
    }

    private func post<RequestBody: Encodable, ResponseBody: Decodable>(
        path: String,
        body: RequestBody
    ) throws -> ResponseBody {
        let data = try requestSync(path: path, body: JSONEncoder().encode(body))
        return try JSONDecoder().decode(ResponseBody.self, from: data)
    }

    private func requestSync(path: String, body: Data) throws -> Data {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<Data, Error> = .failure(SdkDatabaseError.unavailable(Self.unavailableMessage))

        urlSession.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error {
                result = .failure(SdkDatabaseError.unavailable("\(Self.unavailableMessage): \(error.localizedDescription)"))
                return
            }

            guard let http = response as? HTTPURLResponse else {
                result = .failure(SdkDatabaseError.badResponse("database inspection returned a non-HTTP response"))
                return
            }

            guard (200..<300).contains(http.statusCode), let data else {
                let message = data.flatMap { try? JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: $0).error }
                    ?? "HTTP \(http.statusCode)"
                result = .failure(SdkDatabaseError.unavailable("\(Self.unavailableMessage): \(message)"))
                return
            }

            result = .success(data)
        }.resume()

        semaphore.wait()
        return try result.get()
    }

    private static let unavailableMessage = "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"
}

private struct EmptyRequest: Codable {}
