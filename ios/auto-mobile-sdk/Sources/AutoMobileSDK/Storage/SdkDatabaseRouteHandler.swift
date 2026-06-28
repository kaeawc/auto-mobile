#if DEBUG && !os(watchOS)
import Foundation

struct SdkRouteResponse {
    let statusCode: Int
    let body: Data
}

struct SdkExecuteSqlRequest: Codable {
    let databasePath: String
    let query: String
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
}

struct SdkDatabaseListPayload: Codable {
    let databases: [SdkDatabaseDescriptorPayload]
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
}

struct SdkTableStructurePayload: Codable {
    let columns: [SdkColumnInfoPayload]
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
}

final class SdkDatabaseRouteHandler {
    func handleListDatabases() -> SdkRouteResponse {
        guard let driver = DatabaseInspector.shared.getDriver() else {
            return error(statusCode: 503, code: "db_inspection_disabled")
        }

        let databases = driver.getDatabases().map {
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

        return encode(SdkTablesPayload(tables: driver.getTables(databasePath: request.databasePath)))
    }

    func handleTableData(body: Data) -> SdkRouteResponse {
        guard let driver = DatabaseInspector.shared.getDriver() else {
            return error(statusCode: 503, code: "db_inspection_disabled")
        }
        guard let request = try? JSONDecoder().decode(SdkTableDataRequest.self, from: body) else {
            return error(statusCode: 400, code: "bad_request")
        }

        let result = driver.getTableData(
            databasePath: request.databasePath,
            table: request.table,
            limit: request.limit,
            offset: request.offset
        )
        return encode(SdkTableDataPayload(columns: result.columns, rows: result.rows, total: result.totalRows))
    }

    func handleTableStructure(body: Data) -> SdkRouteResponse {
        guard let driver = DatabaseInspector.shared.getDriver() else {
            return error(statusCode: 503, code: "db_inspection_disabled")
        }
        guard let request = try? JSONDecoder().decode(SdkTableStructureRequest.self, from: body) else {
            return error(statusCode: 400, code: "bad_request")
        }

        let result = driver.getTableStructure(databasePath: request.databasePath, table: request.table)
        return encode(SdkTableStructurePayload(columns: result.columns.map {
            SdkColumnInfoPayload(
                name: $0.name,
                type: $0.type,
                nullable: $0.isNullable,
                primaryKey: $0.isPrimaryKey,
                defaultValue: $0.defaultValue
            )
        }))
    }

    func handleExecuteSql(body: Data) -> SdkRouteResponse {
        guard let driver = DatabaseInspector.shared.getDriver() else {
            return error(statusCode: 503, code: "db_inspection_disabled")
        }
        guard let request = try? JSONDecoder().decode(SdkExecuteSqlRequest.self, from: body) else {
            return error(statusCode: 400, code: "bad_request")
        }

        let result = driver.executeSQL(databasePath: request.databasePath, query: request.query)
        let payload = SdkExecuteSqlPayload(
            queryType: result.columns == nil ? "mutation" : "query",
            columns: result.columns,
            rows: result.rows,
            rowsAffected: result.rowsAffected,
            error: result.error
        )
        return encode(payload)
    }

    private func encode<T: Encodable>(_ payload: T) -> SdkRouteResponse {
        guard let data = try? JSONEncoder().encode(payload) else {
            return error(statusCode: 500, code: "encode_failed")
        }
        return SdkRouteResponse(statusCode: 200, body: data)
    }

    private func error(statusCode: Int, code: String) -> SdkRouteResponse {
        let payload = SdkDatabaseErrorPayload(error: code)
        let body = (try? JSONEncoder().encode(payload)) ?? Data("{\"error\":\"\(code)\"}".utf8)
        return SdkRouteResponse(statusCode: statusCode, body: body)
    }
}
#endif
