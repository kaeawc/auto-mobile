import Foundation

/// Rows of a single inspected table returned by the in-app SDK. Ported from the
/// reference `SdkDatabaseClient.swift`; immutable value type, so `Sendable`.
public struct SdkTableDataResult: Codable, Equatable, Sendable {
    public let columns: [String]
    public let rows: [[String?]]
    public let total: Int
    public let diagnostic: SdkStorageDiagnostic?

    public init(columns: [String], rows: [[String?]], total: Int, diagnostic: SdkStorageDiagnostic? = nil) {
        self.columns = columns
        self.rows = rows
        self.total = total
        self.diagnostic = diagnostic
    }
}
