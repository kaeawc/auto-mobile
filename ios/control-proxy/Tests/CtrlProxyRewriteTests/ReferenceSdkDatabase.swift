@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE SDK database result models + DB response envelopes. Imports
/// only `CtrlProxy` (see `ReferenceWireDecoder`) and exposes module-agnostic returns
/// (sorted-key encoded bytes / normalized tuples) so a test importing neither module
/// can diff old vs new.
enum ReferenceSdkDatabase {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func reencode<T: Codable>(_ type: T.Type, _ data: Data) throws -> Data {
        try sortedEncoder().encode(try JSONDecoder().decode(type, from: data))
    }

    // SDK result models (decoded from the in-app SDK's HTTP responses).
    static func diagnostic(_ d: Data) throws -> Data { try reencode(SdkStorageDiagnostic.self, d) }
    static func databaseInfo(_ d: Data) throws -> Data { try reencode(SdkDatabaseInfo.self, d) }
    static func columnInfo(_ d: Data) throws -> Data { try reencode(SdkColumnInfo.self, d) }
    static func storageCapabilities(_ d: Data) throws -> Data { try reencode(SdkStorageCapabilities.self, d) }
    static func executeSqlResult(_ d: Data) throws -> Data { try reencode(SdkExecuteSqlResult.self, d) }
    static func tableDataResult(_ d: Data) throws -> Data { try reencode(SdkTableDataResult.self, d) }
    static func tableStructureResult(_ d: Data) throws -> Data { try reencode(SdkTableStructureResult.self, d) }

    /// `capabilities` is a `Set<String>`; return normalized (sorted) so parity does
    /// not depend on per-process Set iteration order.
    static func serverInfo(_ d: Data) throws -> (String, String?, [String]) {
        let info = try JSONDecoder().decode(SdkHierarchyServerInfo.self, from: d)
        return (info.status, info.bundleId, info.capabilities.sorted())
    }

    // DB response envelopes (built by CommandHandler, serialized onto the wire).
    static func executeSqlResponse(_ d: Data) throws -> Data { try reencode(ExecuteSqlResponse.self, d) }
    static func listDatabasesResponse(_ d: Data) throws -> Data { try reencode(ListDatabasesResponse.self, d) }
    static func storageCapabilitiesResponse(_ d: Data) throws -> Data { try reencode(StorageCapabilitiesResponse.self, d) }
    static func listTablesResponse(_ d: Data) throws -> Data { try reencode(ListTablesResponse.self, d) }
    static func tableDataResponse(_ d: Data) throws -> Data { try reencode(TableDataResponse.self, d) }
    static func tableStructureResponse(_ d: Data) throws -> Data { try reencode(TableStructureResponse.self, d) }
}
