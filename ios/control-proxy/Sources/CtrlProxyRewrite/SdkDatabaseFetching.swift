import Foundation

/// Protocol for relaying SQLite database inspection requests to the target app SDK.
/// Ported from the reference `Protocols.swift`; every method is now `async throws` (the
/// reference blocked on a `DispatchSemaphore`). Refines `Sendable` so a Phase-6
/// `Sendable` CommandHandler can hold it.
public protocol SdkDatabaseFetching: Sendable {
    func executeSQL(databasePath: String, query: String, sessionId: String?) async throws -> SdkExecuteSqlResult
    func listDatabases() async throws -> [SdkDatabaseInfo]
    func storageCapabilities() async throws -> SdkStorageCapabilities
    func listTables(databasePath: String) async throws -> [String]
    func getTableData(databasePath: String, table: String, limit: Int, offset: Int) async throws -> SdkTableDataResult
    func getTableStructure(databasePath: String, table: String) async throws -> SdkTableStructureResult
}
