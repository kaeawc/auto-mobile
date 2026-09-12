import Foundation

/// `execute_sql_result` envelope. Ported from the reference `Models.swift`;
/// `Codable, Sendable` value type. (Joins `WebSocketResponsePayload` in the
/// CommandHandler phase, alongside the other handler-built envelopes.)
public struct ExecuteSqlResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let queryType: String?
    public let columns: [String]?
    public let rows: [[String?]]?
    public let rowsAffected: Int?
    public let error: String?
    public let diagnostic: SdkStorageDiagnostic?
    public let truncated: Bool?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        queryType: String? = nil,
        columns: [String]? = nil,
        rows: [[String?]]? = nil,
        rowsAffected: Int? = nil,
        error: String? = nil,
        diagnostic: SdkStorageDiagnostic? = nil,
        truncated: Bool? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.executeSqlResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.queryType = queryType
        self.columns = columns
        self.rows = rows
        self.rowsAffected = rowsAffected
        self.error = error
        self.diagnostic = diagnostic
        self.truncated = truncated
        self.totalTimeMs = totalTimeMs
    }
}
