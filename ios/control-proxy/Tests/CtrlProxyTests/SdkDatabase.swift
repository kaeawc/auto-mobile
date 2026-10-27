@testable import CtrlProxy
import Foundation

/// Drives the `CtrlProxy` SDK database result models + DB response envelopes
/// Imports only `CtrlProxy`.
enum SdkDatabase {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func reencode<T: Codable>(_ type: T.Type, _ data: Data) throws -> Data {
        try sortedEncoder().encode(JSONDecoder().decode(type, from: data))
    }

    static func diagnostic(_ data: Data) throws -> Data { try reencode(SdkStorageDiagnostic.self, data) }
    static func databaseInfo(_ data: Data) throws -> Data { try reencode(SdkDatabaseInfo.self, data) }
    static func columnInfo(_ data: Data) throws -> Data { try reencode(SdkColumnInfo.self, data) }
    static func storageCapabilities(_ data: Data) throws -> Data { try reencode(SdkStorageCapabilities.self, data) }
    static func executeSqlResult(_ data: Data) throws -> Data { try reencode(SdkExecuteSqlResult.self, data) }
    static func tableDataResult(_ data: Data) throws -> Data { try reencode(SdkTableDataResult.self, data) }
    static func tableStructureResult(_ data: Data) throws -> Data { try reencode(SdkTableStructureResult.self, data) }

    static func serverInfo(_ data: Data) throws -> (String, String?, [String]) {
        let info = try JSONDecoder().decode(SdkHierarchyServerInfo.self, from: data)
        return (info.status, info.bundleId, info.capabilities.sorted())
    }

    static func executeSqlResponse(_ data: Data) throws -> Data { try reencode(ExecuteSqlResponse.self, data) }
    static func listDatabasesResponse(_ data: Data) throws -> Data { try reencode(ListDatabasesResponse.self, data) }
    static func storageCapabilitiesResponse(_ data: Data) throws
        -> Data { try reencode(StorageCapabilitiesResponse.self, data) }
    static func listTablesResponse(_ data: Data) throws -> Data { try reencode(ListTablesResponse.self, data) }
    static func tableDataResponse(_ data: Data) throws -> Data { try reencode(TableDataResponse.self, data) }
    static func tableStructureResponse(_ data: Data) throws -> Data { try reencode(TableStructureResponse.self, data) }
}
