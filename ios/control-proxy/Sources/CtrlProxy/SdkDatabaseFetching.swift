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
    func listDatabases() async throws -> [SdkDatabaseInfo]
    func storageCapabilities() async throws -> SdkStorageCapabilities
    func listTables(databasePath: String) async throws -> [String]
    func getTableData(databasePath: String, table: String, limit: Int, offset: Int) async throws -> SdkTableDataResult
    func getTableStructure(databasePath: String, table: String) async throws -> SdkTableStructureResult
}
