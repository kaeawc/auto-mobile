import Foundation

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
