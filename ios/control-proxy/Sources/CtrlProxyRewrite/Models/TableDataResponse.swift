import Foundation

/// `table_data_result` envelope. Ported from the reference `Models.swift`;
/// `Codable, Sendable` value type. (Joins `WebSocketResponsePayload` in the
/// CommandHandler phase.)
public struct TableDataResponse: Codable, Sendable {
    public let type: String
    public let timestamp: Int64
    public let requestId: String?
    public let success: Bool
    public let columns: [String]?
    public let rows: [[String?]]?
    public let total: Int?
    public let error: String?
    public let diagnostic: SdkStorageDiagnostic?
    public let totalTimeMs: Int64?

    public init(
        requestId: String?,
        success: Bool,
        columns: [String]? = nil,
        rows: [[String?]]? = nil,
        total: Int? = nil,
        error: String? = nil,
        diagnostic: SdkStorageDiagnostic? = nil,
        totalTimeMs: Int64? = nil
    ) {
        type = ResponseType.tableDataResult.rawValue
        timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        self.requestId = requestId
        self.success = success
        self.columns = columns
        self.rows = rows
        self.total = total
        self.error = error
        self.diagnostic = diagnostic
        self.totalTimeMs = totalTimeMs
    }
}
