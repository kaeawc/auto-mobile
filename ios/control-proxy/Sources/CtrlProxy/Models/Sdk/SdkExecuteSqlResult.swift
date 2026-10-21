import Foundation

public struct SdkExecuteSqlResult: Codable, Equatable, Sendable {
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
