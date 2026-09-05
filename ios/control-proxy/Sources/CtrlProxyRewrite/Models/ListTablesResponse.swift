import Foundation

/// `list_tables_result` envelope. Ported from the reference `Models.swift`;
/// `Codable, Sendable` value type. (Joins `WebSocketResponsePayload` in the
/// CommandHandler phase.)
public struct ListTablesResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let tables: [String]?
    public let error: String?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        tables: [String]? = nil,
        error: String? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.listTablesResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.tables = tables
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
