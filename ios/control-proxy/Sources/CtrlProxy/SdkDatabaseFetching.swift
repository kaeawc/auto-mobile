import AutoMobileSdkWire
import Foundation

public protocol SdkDatabaseFetching: Sendable {
    func executeSQL(
        databasePath: String,
        query: String,
        sessionId: String?,
        mutationToken: String?,
        readOnly: Bool?
    ) async throws
        -> SdkExecuteSqlResult
    func queryCoreData(store: String, entity: String, limit: Int?) async throws -> CoreDataQueryResult
    func listDatabases() async throws -> [SdkDatabaseInfo]
    func storageCapabilities() async throws -> SdkStorageCapabilities
    func listTables(databasePath: String) async throws -> [String]
    func getTableData(databasePath: String, table: String, limit: Int, offset: Int) async throws -> SdkTableDataResult
    func getTableStructure(databasePath: String, table: String) async throws -> SdkTableStructureResult
}

extension SdkDatabaseFetching {
    public func queryCoreData(store _: String, entity _: String, limit _: Int?) async throws -> CoreDataQueryResult {
        throw SdkDatabaseError.unavailable("core_data_query_unavailable")
    }
}
